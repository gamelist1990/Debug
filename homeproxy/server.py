"""homeproxy — 家の PC で動く HTTP(S) 認証プロキシ (asyncio, stdlib only).

pproxy は Python 3.14 の asyncio.get_event_loop() 変更で動かなくなったので、
自前で書き直したもの。依存なしで動く。

サポート:
- HTTP CONNECT (HTTPS トンネル): CloakBrowser / curl / Playwright が使う
- HTTP GET/POST 等の平文リクエスト転送 (念のため)
- Basic 認証 (Proxy-Authorization ヘッダ)
- IPv4 / IPv6

使い方:
    1. .env.example を .env にコピーして PROXY_USER / PROXY_PASS を設定
    2. `python server.py`  (もしくは start.ps1)
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


logging.basicConfig(level=logging.INFO, format="[homeproxy] %(message)s")
log = logging.getLogger("homeproxy")


# ---------------------------------------------------------------------------
# HTTP プロキシ実装
# ---------------------------------------------------------------------------
class ProxyServer:
    def __init__(self, host: str, port: int, user: str, password: str):
        self.host = host
        self.port = port
        cred = f"{user}:{password}".encode("utf-8")
        self.expected_auth = b"Basic " + base64.b64encode(cred)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=30)
            if not request_line:
                return
            headers: list[bytes] = []
            auth_header: bytes | None = None
            content_length = 0
            host_header: str | None = None
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=30)
                if line in (b"\r\n", b"\n", b""):
                    break
                headers.append(line)
                lower = line.lower()
                if lower.startswith(b"proxy-authorization:"):
                    auth_header = line.split(b":", 1)[1].strip()
                elif lower.startswith(b"content-length:"):
                    try:
                        content_length = int(line.split(b":", 1)[1].strip())
                    except ValueError:
                        pass
                elif lower.startswith(b"host:"):
                    host_header = line.split(b":", 1)[1].strip().decode("latin1", "replace")

            if auth_header != self.expected_auth:
                log.warning(f"auth failed from {peer}")
                writer.write(
                    b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                    b'Proxy-Authenticate: Basic realm="homeproxy"\r\n'
                    b"Content-Length: 0\r\n"
                    b"Connection: close\r\n\r\n"
                )
                await writer.drain()
                return

            parts = request_line.decode("latin1", "replace").split()
            if len(parts) < 3:
                await self._reply_error(writer, 400, "Bad Request")
                return
            method, target, _version = parts[0], parts[1], parts[2]

            if method.upper() == "CONNECT":
                await self._handle_connect(reader, writer, target)
            else:
                await self._handle_forward(reader, writer, headers,
                                           method, target, host_header, content_length)
        except asyncio.TimeoutError:
            log.debug(f"timeout from {peer}")
        except Exception as e:
            log.debug(f"handle error {peer}: {e}")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _handle_connect(self, reader: asyncio.StreamReader,
                              writer: asyncio.StreamWriter, target: str) -> None:
        if ":" not in target:
            await self._reply_error(writer, 400, "Bad Request (no port)")
            return
        host, _, port_s = target.rpartition(":")
        host = host.strip("[]")
        try:
            port = int(port_s)
        except ValueError:
            await self._reply_error(writer, 400, "Bad Request (bad port)")
            return
        try:
            up_r, up_w = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=15)
        except Exception as e:
            log.info(f"connect fail {host}:{port} - {e}")
            await self._reply_error(writer, 502, "Bad Gateway")
            return
        writer.write(b"HTTP/1.1 200 Connection Established\r\nConnection: close\r\n\r\n")
        await writer.drain()
        log.info(f"CONNECT {host}:{port}")
        await self._pipe_bidir(reader, writer, up_r, up_w)

    async def _handle_forward(self, reader: asyncio.StreamReader,
                              writer: asyncio.StreamWriter,
                              headers: list[bytes],
                              method: str, target: str,
                              host_header: str | None,
                              content_length: int) -> None:
        from urllib.parse import urlsplit

        if target.lower().startswith("http://") or target.lower().startswith("https://"):
            sp = urlsplit(target)
            host = sp.hostname or host_header or ""
            port = sp.port or (443 if sp.scheme == "https" else 80)
            new_target = sp.path or "/"
            if sp.query:
                new_target += "?" + sp.query
        else:
            if not host_header:
                await self._reply_error(writer, 400, "Bad Request (no host)")
                return
            if ":" in host_header:
                h, _, ps = host_header.partition(":")
                host, port = h, int(ps)
            else:
                host, port = host_header, 80
            new_target = target

        try:
            up_r, up_w = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=15)
        except Exception as e:
            log.info(f"forward fail {host}:{port} - {e}")
            await self._reply_error(writer, 502, "Bad Gateway")
            return

        log.info(f"{method} {host}:{port}{new_target}")

        new_request_line = f"{method} {new_target} HTTP/1.1\r\n".encode("latin1")
        up_w.write(new_request_line)
        for h in headers:
            low = h.lower()
            if low.startswith(b"proxy-") or low.startswith(b"connection:"):
                continue
            up_w.write(h)
        up_w.write(b"Connection: close\r\n\r\n")

        if content_length > 0:
            remaining = content_length
            while remaining > 0:
                chunk = await reader.read(min(65536, remaining))
                if not chunk:
                    break
                up_w.write(chunk)
                remaining -= len(chunk)
        await up_w.drain()

        await self._pipe_bidir(reader, writer, up_r, up_w)

    @staticmethod
    async def _pipe_bidir(cli_r, cli_w, up_r, up_w):
        async def _pipe(src, dst):
            try:
                while True:
                    data = await src.read(65536)
                    if not data:
                        break
                    dst.write(data)
                    await dst.drain()
            except Exception:
                pass
            finally:
                try:
                    dst.close()
                except Exception:
                    pass
        await asyncio.gather(_pipe(cli_r, up_w), _pipe(up_r, cli_w))

    @staticmethod
    async def _reply_error(writer, code: int, msg: str) -> None:
        body = msg.encode("utf-8")
        writer.write(
            f"HTTP/1.1 {code} {msg}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n".encode("latin1") + body
        )
        try:
            await writer.drain()
        except Exception:
            pass

    async def serve(self) -> None:
        server = await asyncio.start_server(self.handle, self.host, self.port)
        addrs = ", ".join(str(s.getsockname()) for s in server.sockets)
        log.info(f"listening on {addrs} (http, auth required)")
        async with server:
            await server.serve_forever()


def main() -> int:
    load_dotenv(BASE_DIR / ".env")

    user = os.environ.get("PROXY_USER", "").strip()
    pw = os.environ.get("PROXY_PASS", "").strip()
    port = int(os.environ.get("PROXY_PORT", "8888"))
    host = os.environ.get("PROXY_HOST", "127.0.0.1").strip()

    if not user or not pw or user.startswith("changeme") or pw.startswith("changeme"):
        log.error("PROXY_USER / PROXY_PASS \u304c\u672a\u8a2d\u5b9a\u3067\u3059\u3002.env \u3092\u66f8\u304d\u63db\u3048\u3066\u304f\u3060\u3055\u3044\u3002")
        return 2

    log.info(f"user={user!r}")
    if host == "127.0.0.1":
        log.info("mode: LOCAL-ONLY (SSH tunnel expected).")
        log.info(f"  VPS \u5074\u304b\u3089\u306e\u60f3\u5b9a URL: http://{user}:{pw}@127.0.0.1:{port}")
    else:
        log.info("mode: PUBLIC. router forwarding + firewall check!")

    server = ProxyServer(host, port, user, pw)

    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        log.info("stopped by user")
    return 0


if __name__ == "__main__":
    sys.exit(main())
