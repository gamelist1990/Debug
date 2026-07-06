"""homeproxy — 家の PC で動く HTTP + SOCKS5 プロキシ.

pproxy をラップして、`.env` から user/pass/port を読んで起動する。

使い方:
    1. .env.example を .env にコピーして PROXY_USER / PROXY_PASS を設定
    2. `pip install -r requirements.txt`
    3. `python server.py`   (もしくは start.ps1)

出力例:
    [homeproxy] listening on 127.0.0.1:8888 (http+socks5, auth required)
    [homeproxy] user='xxx' — from VPS use:
    [homeproxy]   PROXY_SERVER=http://xxx:yyy@127.0.0.1:8888  (via SSH tunnel)
"""
from __future__ import annotations

import os
import shlex
import subprocess
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


def main() -> int:
    load_dotenv(BASE_DIR / ".env")

    user = os.environ.get("PROXY_USER", "").strip()
    pw = os.environ.get("PROXY_PASS", "").strip()
    port = int(os.environ.get("PROXY_PORT", "8888"))
    host = os.environ.get("PROXY_HOST", "127.0.0.1").strip()

    if not user or not pw or user.startswith("changeme") or pw.startswith("changeme"):
        print("[ERROR] PROXY_USER / PROXY_PASS が未設定です。.env を書き換えてください。")
        return 2

    if "#" in user or "#" in pw or "@" in user or "@" in pw or ":" in user or ":" in pw:
        print("[ERROR] PROXY_USER / PROXY_PASS に # : @ を含めないでください。")
        return 2

    # pproxy の URI 形式: `http+socks5://host:port#user:pass`
    # `#user:pass` を付けるとその listener で認証必須になる。
    listen_uri = f"http+socks5://{host}:{port}#{user}:{pw}"

    print(f"[homeproxy] listening on {host}:{port} (http+socks5, auth required)")
    print(f"[homeproxy] user={user!r}")
    if host == "127.0.0.1":
        print("[homeproxy] mode: LOCAL-ONLY (SSH tunnel expected). "
              "VPS should reach it via 127.0.0.1 through the reverse tunnel.")
        print(f"[homeproxy]   PROXY_SERVER=http://{user}:{pw}@127.0.0.1:{port}")
    else:
        print("[homeproxy] mode: PUBLIC. Make sure your router forwards the port"
              " and Windows Firewall allows inbound.")
        print(f"[homeproxy]   PROXY_SERVER=http://{user}:{pw}@<家のグローバルIP>:{port}")
    print("[homeproxy] Ctrl+C to stop.")

    # pproxy はエントリポイントの CLI 呼び出しが一番安定するので
    # モジュール実行する。
    cmd = [sys.executable, "-m", "pproxy", "-l", listen_uri, "-v"]
    try:
        return subprocess.call(cmd)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
