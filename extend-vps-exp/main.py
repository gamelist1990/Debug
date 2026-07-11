"""Xserver free VPS auto-renew — CloakBrowser edition.

Uses CloakBrowser (stealth Chromium with C++ source-level patches) to bypass
Cloudflare Turnstile natively, and a local Keras model to read the numeric
CAPTCHA image.

Environment variables (all optional except EMAIL/PASSWORD):
    EMAIL, PASSWORD          — Xserver login credentials (required)
    HEADLESS                 — "1"/"true" to force headless (default: headed via Xvfb)
    CI                       — set in CI/cron: no interactive prompts
    PROXY_SERVER             — proxy URL (http://, https://, socks5://)
    CLOAKBROWSER_LICENSE_KEY — CloakBrowser Pro license (unlocks Chromium 148)
    CAPTCHA_MODEL_PATH       — override the location of xserver_captcha.keras
    DEBUG_VIDEO              — "1" to assemble frames/ into an mp4 with ffmpeg
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from getpass import getpass
from pathlib import Path
from typing import Optional

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# .env loader (no external dep)
# ---------------------------------------------------------------------------
def _load_dotenv(path: str) -> None:
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_dotenv(os.path.join(BASE_DIR, ".env"))

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger("xserver-renew").info


# ---------------------------------------------------------------------------
# 「まだ更新不要」時の次回スキップ管理
# ---------------------------------------------------------------------------
# .newApp__suspended に「YYYY年M月D日以降にお試しください」と書かれている
# 場合、その日付までは何度実行しても結果は同じ (=更新不可)。無駄な通信、
# ログイン試行、Cloudflare 通過試行、Discord 再通知を減らすため、その日付を
# state ファイルに保存しておき、翌回以降の cron 実行は日付を過ぎるまで即
# return 0 でスキップする。強制的に走らせたいときは環境変数 FORCE_RUN=1 を
# 付けて実行すればスキップ判定は無視される。
SKIP_STATE_PATH = Path(BASE_DIR) / "skip_until.txt"

# 例: "2026年7月12日以降にお試しください"
_NEXT_RENEWABLE_DATE_RE = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")


def _today_jst():
    """Return today's date in JST (the target service is JP-only)."""
    try:
        from zoneinfo import ZoneInfo  # Python 3.9+
        return datetime.now(ZoneInfo("Asia/Tokyo")).date()
    except Exception:
        # Fallback: naive local date. Fine if host clock is close to JST.
        return datetime.now().date()


def _parse_next_renewable_date(text: str):
    """Extract "YYYY年M月D日" from a suspended-banner message.

    Returns a ``datetime.date`` or ``None`` if no date is found / invalid.
    """
    if not text:
        return None
    m = _NEXT_RENEWABLE_DATE_RE.search(text)
    if not m:
        return None
    try:
        from datetime import date
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except Exception:
        return None


def _save_skip_until(next_date) -> None:
    """Persist "skip runs until this date" so future cron ticks exit early."""
    if next_date is None:
        return
    try:
        SKIP_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        SKIP_STATE_PATH.write_text(next_date.isoformat() + "\n", encoding="utf-8")
        log(f"[skip] next attempt allowed on {next_date.isoformat()} (state saved)")
    except Exception as e:
        log(f"[skip] failed to save state: {e}")


def _load_skip_until():
    """Read the previously-saved skip-until date, or None if unset/invalid."""
    try:
        if not SKIP_STATE_PATH.is_file():
            return None
        raw = SKIP_STATE_PATH.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        from datetime import date
        y, mo, d = raw.split("-")
        return date(int(y), int(mo), int(d))
    except Exception as e:
        log(f"[skip] failed to read state: {e}")
        return None


def _clear_skip_until() -> None:
    """Drop the state file (e.g. after a successful renewal)."""
    try:
        if SKIP_STATE_PATH.is_file():
            SKIP_STATE_PATH.unlink()
            log("[skip] state cleared")
    except Exception as e:
        log(f"[skip] failed to clear state: {e}")


def _force_run_requested() -> bool:
    """True if user set FORCE_RUN=1 to bypass the skip-until gate."""
    return os.environ.get("FORCE_RUN", "").lower() in {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------
# PROXY_SERVER 正規化
# ---------------------------------------------------------------------------
# 住宅プロキシで良く見る「host:port:user:pass」形式を、
# 標準の URL 形式 (scheme://user:pass@host:port) に自動変換する。
#
# 対応例:
#   http://142.111.67.146:5611:cfvsvqyn:qhyrc0uaykta
#     -> http://cfvsvqyn:qhyrc0uaykta@142.111.67.146:5611
#   142.111.67.146:5611:cfvsvqyn:qhyrc0uaykta          (scheme 省略)
#     -> http://cfvsvqyn:qhyrc0uaykta@142.111.67.146:5611
#   http://user:pass@host:port                        (既に標準形式)
#     -> そのまま
def _normalize_proxy(raw: str | None) -> str | None:
    if not raw:
        return raw
    s = raw.strip()
    if not s:
        return None

    # scheme 分離
    if "://" in s:
        scheme, rest = s.split("://", 1)
    else:
        scheme, rest = "http", s

    # 既に user:pass@host:port ならそのまま
    if "@" in rest:
        return f"{scheme}://{rest}"

    parts = rest.split(":")
    # host:port:user:pass  (コロン 4 つ)
    if len(parts) == 4:
        host, port, user, pw = parts
        return f"{scheme}://{user}:{pw}@{host}:{port}"
    # host:port  (認証なし)
    if len(parts) == 2:
        return f"{scheme}://{rest}"

    # それ以外はいじらない (不正なら至上流でエラーになる)
    return f"{scheme}://{rest}"

LOGIN_URL = "https://secure.xserver.ne.jp/xapanel/login/xvps/"


# ---------------------------------------------------------------------------
# Frame capture (numbered PNGs, main-thread only)
# ---------------------------------------------------------------------------
class FrameCapture:
    """Save numbered screenshots so the flow can be replayed after the fact.

    Frames land at ``frames/frame_NNNNN.png``. Old frames are wiped at start
    so operators only see the current run. Optional: if ``DEBUG_VIDEO=1`` and
    ``ffmpeg`` is on PATH, ``finalize()`` also assembles ``frames/debug.mp4``.
    """

    def __init__(self, out_dir: Path):
        self.out_dir = out_dir
        self.index = 0
        self.events_path = out_dir / "events.log"
        try:
            if out_dir.exists():
                for p in out_dir.glob("frame_*.png"):
                    try:
                        p.unlink()
                    except OSError:
                        pass
                try:
                    self.events_path.unlink()
                except OSError:
                    pass
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

    def snap(self, page, label: str) -> None:
        self.index += 1
        frame_path = self.out_dir / f"frame_{self.index:05d}.png"
        try:
            page.screenshot(path=str(frame_path), type="png", full_page=False)
        except Exception as e:
            log(f"[frame] screenshot failed at {label}: {e}")
            return
        try:
            with open(self.events_path, "a", encoding="utf-8") as f:
                f.write(f"{datetime.now().isoformat()} frame={self.index:05d} label={label}\n")
        except OSError:
            pass

    def finalize(self) -> None:
        if os.environ.get("DEBUG_VIDEO", "0").lower() not in {"1", "true", "yes", "on"}:
            return
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg or self.index == 0:
            return
        video_path = self.out_dir / "debug.mp4"
        cmd = [
            ffmpeg, "-y", "-framerate", "1",
            "-i", str(self.out_dir / "frame_%05d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(video_path),
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode == 0:
                log(f"[frame] mp4 saved: {video_path}")
        except Exception as e:
            log(f"[frame] ffmpeg failed: {e}")


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def env_or_prompt(name: str, prompt: str, secret: bool = False) -> str:
    value = os.environ.get(name)
    if value:
        return value
    if os.environ.get("CI"):
        raise RuntimeError(f"Missing required environment variable: {name}")
    return getpass(prompt) if secret else input(prompt)


def _is_headless() -> bool:
    val = os.environ.get("HEADLESS")
    if val is not None:
        return val.lower() in {"1", "true", "yes", "on"}
    # Default: headed. On VPS this needs Xvfb (started by vps_setup.sh).
    return False


def _wait_and_click(locator, timeout_ms: int = 60_000, interval_ms: int = 500) -> None:
    """Poll a locator until it's both visible AND enabled, then click."""
    elapsed = 0
    while elapsed < timeout_ms:
        try:
            if locator.is_visible() and locator.is_enabled():
                locator.click()
                return
        except Exception:
            pass
        locator.page.wait_for_timeout(interval_ms)
        elapsed += interval_ms
    raise TimeoutError(f"element did not become clickable within {timeout_ms}ms")


def _sleep_for_cf(seconds: float) -> None:
    """Passive wait (fallback path).

    Used only when no Turnstile widget is detected — we still want to give
    non-interactive challenges time to settle.
    """
    time.sleep(seconds)


# ---------------------------------------------------------------------------
# Cloudflare Turnstile のアクティブ対応
# ---------------------------------------------------------------------------
def _read_turnstile_token(page) -> str:
    """input[name=cf-turnstile-response] の value を読む。"""
    try:
        return page.evaluate(
            "() => { const els = document.querySelectorAll('input[name=\"cf-turnstile-response\"]');"
            "        for (const e of els) { if (e.value && e.value.length > 20) return e.value; } return ''; }"
        ) or ""
    except Exception:
        return ""


def _log_turnstile_dom_state(page) -> None:
    """デバッグ用: Turnstile と iframe の状態をログに出す。"""
    try:
        info = page.evaluate(
            "() => {"
            "  const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({"
            "    src: (f.src||'').slice(0, 120),"
            "    title: f.title||'',"
            "    w: f.clientWidth, h: f.clientHeight"
            "  }));"
            "  const widgets = Array.from(document.querySelectorAll('.cf-turnstile,[data-sitekey]')).map(e => ({"
            "    cls: e.className, sitekey: e.getAttribute('data-sitekey')||'',"
            "    w: e.clientWidth, h: e.clientHeight"
            "  }));"
            "  const tokens = Array.from(document.querySelectorAll('input[name=\"cf-turnstile-response\"]')).length;"
            "  const scripts = Array.from(document.querySelectorAll('script[src*=\"cloudflare\"],script[src*=\"turnstile\"]')).map(s => (s.src||'').slice(0,120));"
            "  const hasTurnstileGlobal = typeof window.turnstile !== 'undefined';"
            "  const turnstileMethods = hasTurnstileGlobal ? Object.keys(window.turnstile) : [];"
            "  return {iframes, widgets, tokenInputs: tokens, scripts, hasTurnstileGlobal, turnstileMethods};"
            "}"
        )
        log(f"[cf][debug] iframes={info.get('iframes')} widgets={info.get('widgets')} token_inputs={info.get('tokenInputs')}")
        log(f"[cf][debug] scripts={info.get('scripts')} turnstile_global={info.get('hasTurnstileGlobal')} methods={info.get('turnstileMethods')}")
    except Exception as e:
        log(f"[cf][debug] dom probe failed: {e}")


def _try_force_render_turnstile(page) -> str | None:
    """api.js はロードされているのに iframe が生えない場合、
    手動で turnstile.render() を呼んでやる。

    重要: widget の data-callback (サイト本来の callback 関数名) を保存しておき、
    自分の callback からもチェーン呼び出しする。これをしないとサイトのフォーム側の
    JS (submit ボタンの disabled 解除実行等) が発火せず、ボタンが永遠に
    クリック不能になる。

    戻り値: 成功時は widget ID (文字列)、失敗時は None。
    """
    try:
        result = page.evaluate(
            "() => {"
            "  if (typeof window.turnstile === 'undefined') return {ok:false, reason:'no_global'};"
            "  const widget = document.querySelector('.cf-turnstile');"
            "  if (!widget) return {ok:false, reason:'no_widget'};"
            "  const sitekey = widget.getAttribute('data-sitekey');"
            "  if (!sitekey) return {ok:false, reason:'no_sitekey'};"
            "  /* サイト本来の callback 名を保存 (あとでチェーン呼び出し) */"
            "  const siteCbName = widget.getAttribute('data-callback');"
            "  window.__cfToken = '';"
            "  window.__cfError = '';"
            "  window.__cfSiteCbError = '';"
            "  window.__cfSiteCbName = siteCbName;"
            "  try {"
            "    const opts = {"
            "      sitekey: sitekey,"
            "      callback: (t) => {"
            "        window.__cfToken = t;"
            "        /* ★ サイト本来の callback もチェーン呼び出し (submit ボタンを enable にする) */"
            "        if (siteCbName && typeof window[siteCbName] === 'function') {"
            "          try { window[siteCbName](t); }"
            "          catch (e) { window.__cfSiteCbError = String(e); }"
            "        }"
            "      },"
            "      'error-callback': (e) => { window.__cfError = String(e); },"
            "      'expired-callback': () => { window.__cfToken = ''; },"
            "    };"
            "    const dataSize = widget.getAttribute('data-size');"
            "    if (dataSize) opts.size = dataSize;"
            "    const id = window.turnstile.render(widget, opts);"
            "    return {ok:true, id: String(id), siteCallback: siteCbName};"
            "  } catch (e) { return {ok:false, reason:'render_error', err: String(e)}; }"
            "}"
        )
        log(f"[cf] force render result: {result}")
        if result and result.get("ok"):
            return result.get("id") or ""
        return None
    except Exception as e:
        log(f"[cf] force render exception: {e}")
        return None


# scrapling 流: CF challenge iframe は document.querySelectorAll('iframe') では
# 見えないことがある (Shadow iframe / closed frame)。page.frame(url=regex) だけ
# が見つけられる。
_CF_FRAME_URL_PATTERN = re.compile(r"^https?://challenges\.cloudflare\.com/cdn-cgi/challenge-platform/.*")


def _find_cf_challenge_frame(page):
    """Playwright の frame() API で CF challenge iframe を探す。

    document.querySelectorAll('iframe') で見えないことがあるので、
    Playwright の frame リストから URL マッチで見つける。
    """
    try:
        # 直接 frame(url=regex) を使う
        frame = page.frame(url=_CF_FRAME_URL_PATTERN)
        if frame:
            return frame
    except Exception:
        pass
    # フォールバック: 全 frame をスキャン
    try:
        for f in page.frames:
            u = getattr(f, "url", "") or ""
            if "challenges.cloudflare.com" in u:
                return f
    except Exception:
        pass
    return None


def _try_click_turnstile(page) -> bool:
    """Turnstile の checkbox を scrapling 流でクリックする。

    page.frame(url=CF_PATTERN) で iframe を見つけて、その frame_element の
    bounding_box に対してクリックする (scrapling 流)。
    """
    try:
        cf_frame = _find_cf_challenge_frame(page)
        if not cf_frame:
            return False
        try:
            frame_element = cf_frame.frame_element()
            box = frame_element.bounding_box()
            if not box or box.get("width", 0) < 20:
                return False
            # scrapling と同じ offset: (26~28, 25~27)px
            import random as _random
            target_x = box["x"] + _random.randint(26, 28)
            target_y = box["y"] + _random.randint(25, 27)
            log(f"[cf] CF frame found via page.frame(url=), box={box}, clicking ({target_x:.0f}, {target_y:.0f})")
            # 人間っぽいアプローチ + click with delay (scrapling 流)
            page.mouse.move(target_x - 60, target_y - 20, steps=15)
            time.sleep(0.15)
            page.mouse.move(target_x, target_y, steps=10)
            time.sleep(0.1)
            page.mouse.click(target_x, target_y, delay=_random.randint(100, 200), button="left")
            return True
        except Exception as e:
            log(f"[cf] frame_element bounding_box failed: {e}")
            return False
    except Exception as e:
        log(f"[cf] click attempt exception: {e}")
        return False


def _solve_turnstile(page, cap=None, max_seconds: float = 30.0) -> bool:
    """Turnstile を能動的に解く。

    手順:
      1. まず 6s 待って non-interactive (auto) で通るか見る。token が生えたら完了。
      2. 生えなければ Turnstile iframe を探してチェックボックスをクリックする。
      3. クリック後さらに poll して token が生えるのを待つ。

    戻り値: True = token が見えた, False = タイムアウトまでに見えなかった

    cap: FrameCapture (オプショナル)。渡されたら CF の途中経過を連連でスナップする。
    """
    def _snap(label: str) -> None:
        if cap is None:
            return
        try:
            cap.snap(page, label)
        except Exception as _e:
            log(f"[cf][snap] failed at {label}: {_e}")

    deadline = time.time() + max_seconds
    _snap("cf_phase1_start")

    # Phase 1: passive wait しながら token を poll
    log("[cf] phase1: passive wait for auto-solve (up to 8s)")
    phase1_end = min(deadline, time.time() + 8.0)
    while time.time() < phase1_end:
        token = _read_turnstile_token(page)
        if token:
            log(f"[cf] token issued during passive wait (len={len(token)})")
            _snap("cf_token_passive")
            return True
        time.sleep(0.5)

    _snap("cf_phase1_end")
    # 現在の DOM 状態をデバッグログ
    _log_turnstile_dom_state(page)

    # iframe がない場合 = Turnstile が render されてない。手動レンダーを試行
    iframe_missing = False
    try:
        iframe_missing = page.evaluate(
            "() => !document.querySelector('iframe[src*=\"challenges.cloudflare.com\"]')"
        )
    except Exception:
        pass

    if iframe_missing:
        log("[cf] iframe is missing — forcing render with site-callback chain")
        _snap("cf_iframe_missing")
        # 手動 render (サイト内の data-callback をチェーン到入する)
        widget_id = _try_force_render_turnstile(page)
        if widget_id is not None:
            log(f"[cf] force-render succeeded (widget id={widget_id!r})")
            _snap("cf_after_render")
            # クリック前に一度だけ iframe が生えるのを 3s 待つ (すぐに passive で解けるケースもある)
            wait_end = min(deadline, time.time() + 3.0)
            while time.time() < wait_end:
                token = _read_turnstile_token(page)
                if token:
                    log(f"[cf] token acquired after force-render passive (len={len(token)})")
                    _snap("cf_token_render")
                    return True
                time.sleep(0.5)
        else:
            log("[cf] force-render failed, falling through to click attempts")
            _snap("cf_render_failed")
        _log_turnstile_dom_state(page)

    # Phase 2: checkbox / widget クリック (最大 3 回リトライ)
    log("[cf] phase2: attempting widget click (with retries)")
    _snap("cf_phase2_start")
    clicked_any = False
    for attempt in range(3):
        if time.time() >= deadline:
            break
        _snap(f"cf_click_{attempt + 1}_before")
        clicked = _try_click_turnstile(page)
        if clicked:
            clicked_any = True
            log(f"[cf] click attempt {attempt + 1} succeeded, polling for token")
            _snap(f"cf_click_{attempt + 1}_after")
            # Phase 3: click 後の polling (最大 8s)
            wait_end = min(deadline, time.time() + 8.0)
            while time.time() < wait_end:
                token = _read_turnstile_token(page)
                if token:
                    log(f"[cf] token issued after click (len={len(token)})")
                    _snap(f"cf_token_click_{attempt + 1}")
                    return True
                time.sleep(0.5)
            log(f"[cf] click attempt {attempt + 1}: no token yet, will retry")
            _snap(f"cf_click_{attempt + 1}_no_token")
        else:
            # まだ widget が見えない → 2s 待って再探索
            log(f"[cf] click attempt {attempt + 1}: no widget visible, waiting 2s")
            _snap(f"cf_click_{attempt + 1}_no_widget")
            time.sleep(2.0)
            token = _read_turnstile_token(page)
            if token:
                log(f"[cf] token issued during retry wait (len={len(token)})")
                _snap(f"cf_token_retry_{attempt + 1}")
                return True

    if not clicked_any:
        log("[cf] no widget ever became clickable")
        _snap("cf_no_widget")
        _log_turnstile_dom_state(page)

    # Phase 4: 最後のパッシブ待機
    log("[cf] phase4: final passive wait until deadline")
    _snap("cf_phase4_start")
    while time.time() < deadline:
        token = _read_turnstile_token(page)
        if token:
            log(f"[cf] token issued in final wait (len={len(token)})")
            _snap("cf_token_final")
            return True
        time.sleep(0.5)

    log("[cf] token not observed within deadline")
    _snap("cf_timeout")
    _log_turnstile_dom_state(page)
    return False


# ---------------------------------------------------------------------------
# 更新不要ページ (.newApp__suspended) 検出
# ---------------------------------------------------------------------------
def _read_suspended_message(page) -> str:
    """Return the suspended-banner text if present, else empty string.

    XVPS の無料 VPS 更新フローでは、利用期限の 1 日前になるまで更新できず
    ``<section class="newApp__suspended">`` が表示される。これは正常系
    (更新不要) なので True を返して抜けたい。
    """
    try:
        loc = page.locator(".newApp__suspended")
        if loc.count() == 0:
            return ""
        txt = loc.first.inner_text(timeout=1_500) or ""
        # Discord embed で読みやすいよう空白を潰す
        txt = re.sub(r"\s+", " ", txt).strip()
        return txt
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Discord webhook 通知 (Python 側 / upsert パターン)
# ---------------------------------------------------------------------------
# vps_setup.sh の notify_discord と挙動を合わせる。初回は POST してメッセージ
# ID を discord_msg_id に保存、以降の実行では PATCH で同じメッセージを
# 上書きしてチャンネルを埋め尽くさないようにする。
#
# status_code -> 色 / 絵文字 / タイトル のマッピング
_DISCORD_STATUS_META = {
    "renewed": {
        "color": 3066993,
        "emoji": "\u2705",
        "title": "更新完了",
        "summary": "無料VPSの更新手続きを正常に送信しました。次回の期限までそのままご利用いただけます。",
    },
    "not_yet_renewable": {
        "color": 3447003,
        "emoji": "\u23f3",
        "title": "まだ更新期間ではありません",
        "summary": "現在は更新できる期間外です。指定日以降に自動で再試行します。",
    },
    "already_renewed": {
        "color": 3447003,
        "emoji": "\u2139\ufe0f",
        "title": "更新対象外",
        "summary": "既に更新済みか、更新ボタンが表示されていませんでした。今回は何もしていません。",
    },
    "not_contracted": {
        "color": 9807270,
        "emoji": "\u26aa",
        "title": "未契約サービス",
        "summary": "このアカウントには無料VPSの契約がありません。",
    },
    "captcha_failed": {
        "color": 15158332,
        "emoji": "\u274c",
        "title": "CAPTCHAを解けませんでした",
        "summary": "画像認証の取得または解析に失敗しました。次回のスケジュール実行で自動的に再試行します。",
    },
    "captcha_wrong": {
        "color": 15158332,
        "emoji": "\u274c",
        "title": "CAPTCHAが不一致でした",
        "summary": "入力したCAPTCHAが受け付けられませんでした。次回のスケジュール実行で自動的に再試行します。",
    },
    "cf_rejected": {
        "color": 15158332,
        "emoji": "\u274c",
        "title": "Cloudflareに拒否されました",
        "summary": "Cloudflare Turnstileの認証を通過できませんでした。次回のスケジュール実行で自動的に再試行します。",
    },
    "exception": {
        "color": 15158332,
        "emoji": "\U0001f4a5",
        "title": "予期せぬエラー",
        "summary": "スクリプトの実行中に例外が発生しました。下記のエラー内容を確認してください。",
    },
}


def _format_jst_now() -> str:
    """Format current time in JST as 'YYYY-MM-DD HH:MM (JST)'."""
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("Asia/Tokyo"))
    except Exception:
        now = datetime.now()
    return now.strftime("%Y-%m-%d %H:%M (JST)")


def _format_next_date_jp(d) -> str:
    """Format a date object as '2026年7月12日 (日)'."""
    if d is None:
        return ""
    weekdays = ["月", "火", "水", "木", "金", "土", "日"]
    try:
        wd = weekdays[d.weekday()]
        return f"{d.year}年{d.month}月{d.day}日 ({wd})"
    except Exception:
        try:
            return d.isoformat()
        except Exception:
            return str(d)


def _discord_msg_id_paths() -> list:
    """discord_msg_id を保存/読出する可能性のあるパス一覧。

    優先順位: 1) BASE_DIR/discord_msg_id (Python がデフォルトで書く場所)
              2) BASE_DIR/../discord_msg_id (vps_setup.sh の INSTALL_DIR)
    """
    paths = [Path(BASE_DIR) / "discord_msg_id"]
    paths.append(Path(BASE_DIR).parent / "discord_msg_id")
    return paths


def _notify_discord(rc: int, status_code: str, detail: str) -> None:
    """Post/PATCH a Discord status embed. No-op if `Discord` env var is unset."""
    import json
    from urllib import request as _urlreq, error as _urlerr

    webhook = os.environ.get("Discord") or os.environ.get("DISCORD_WEBHOOK")
    if not webhook:
        log("[discord] webhook not set — skipping notify")
        return

    meta = _DISCORD_STATUS_META.get(status_code, _DISCORD_STATUS_META["exception"])
    ts = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        host_name = os.uname().nodename  # type: ignore[attr-defined]
    except Exception:
        host_name = os.environ.get("COMPUTERNAME") or "unknown"

    # ---- 見やすい embed を組み立てる ----
    # 従来: 「Status: not_yet_renewable / Exit Code: 0 / Detail: ...」だと
    # 何が起きたのか一目で分からなかったので、
    #   * タイトル = 絵文字 + 日本語ステータス
    #   * 説明文  = 今回何が起きたかの 1 文サマリー
    #   * fields  = 「次回試行可能日 / 発生時刻 / 実行ホスト」等
    # に構造化する。デバッグ用の raw status_code は footer に隠す。
    description_lines = [f"{meta['emoji']} **{meta['title']}**"]
    if meta.get("summary"):
        description_lines.append(meta["summary"])

    embed = {
        "title": "VPS 自動更新レポート",
        "color": meta["color"],
        "description": "\n".join(description_lines),
        "fields": [],
        "footer": {"text": f"VPS Auto Update  \u2022  status={status_code}  \u2022  rc={rc}"},
        "timestamp": ts,
    }

    # 「まだ更新不要」のときは detail に含まれる日付を目立たせて再掲する。
    next_attempt_field = ""
    if status_code == "not_yet_renewable":
        next_date = _parse_next_renewable_date(detail)
        if next_date is not None:
            next_attempt_field = _format_next_date_jp(next_date) + " 以降"
    if next_attempt_field:
        embed["fields"].append({
            "name": "\U0001f4c5 次回試行可能日",
            "value": next_attempt_field,
            "inline": False,
        })

    # 実行メタ情報 (時刻 / ホスト) は 2 列で並べる。
    embed["fields"].append({
        "name": "\U0001f552 実行時刻",
        "value": _format_jst_now(),
        "inline": True,
    })
    embed["fields"].append({
        "name": "\U0001f5a5\ufe0f 実行ホスト",
        "value": host_name,
        "inline": True,
    })

    # detail が付いているケース:
    #   * exception -> トレース。code block で囲うと読みやすい。
    #   * not_yet_renewable -> サイト側の原文。そのまま引用ブロックで見せる。
    #   * その他 (already_renewed / captcha_failed 等) -> 引用ブロック。
    if detail:
        clean_detail = detail.strip()
        if status_code == "exception":
            # code block は ``` の 3 文字 x2 と改行 = 8 文字ぶん引く
            body = clean_detail[:1000]
            embed["fields"].append({
                "name": "\U0001f4a5 エラー内容",
                "value": f"```\n{body}\n```",
                "inline": False,
            })
        else:
            # サイト原文をそのまま貼るときはブロック引用 "> " で整形する。
            body = clean_detail[:1000]
            quoted = "\n".join("> " + ln if ln else ">" for ln in body.splitlines())
            field_name = (
                "\U0001f4dd サイトからのメッセージ"
                if status_code == "not_yet_renewable"
                else "\U0001f4dd 詳細"
            )
            embed["fields"].append({
                "name": field_name,
                "value": quoted,
                "inline": False,
            })

    payload = {"username": "VPS Auto Update", "embeds": [embed]}
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    # ---- PATCH first if we have a cached ID ----
    id_paths = _discord_msg_id_paths()
    cached_id = ""
    cached_from: Optional[Path] = None
    for p in id_paths:
        try:
            if p.is_file():
                cid = p.read_text(encoding="utf-8").strip()
                if cid:
                    cached_id = cid
                    cached_from = p
                    break
        except Exception:
            continue

    if cached_id:
        patch_url = webhook.rstrip("/") + f"/messages/{cached_id}"
        req = _urlreq.Request(patch_url, data=payload_bytes, method="PATCH",
                              headers={"Content-Type": "application/json"})
        try:
            with _urlreq.urlopen(req, timeout=10) as resp:
                if 200 <= resp.status < 300:
                    log(f"[discord] message updated (id={cached_id})")
                    _mark_discord_notified()
                    return
                log(f"[discord] PATCH returned HTTP {resp.status}; will POST fresh")
        except _urlerr.HTTPError as e:
            log(f"[discord] PATCH HTTPError {e.code} — will POST fresh")
            if cached_from is not None:
                try:
                    cached_from.unlink()
                except Exception:
                    pass
        except Exception as e:
            log(f"[discord] PATCH failed: {e} — will POST fresh")

    # ---- POST a new message ----
    post_url = webhook + ("&wait=true" if "?" in webhook else "?wait=true")
    req = _urlreq.Request(post_url, data=payload_bytes, method="POST",
                          headers={"Content-Type": "application/json"})
    try:
        with _urlreq.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        data = json.loads(body) if body else {}
        new_id = str(data.get("id") or "")
        if new_id:
            try:
                id_paths[0].parent.mkdir(parents=True, exist_ok=True)
                id_paths[0].write_text(new_id + "\n", encoding="utf-8")
                log(f"[discord] message sent (id={new_id})")
            except Exception as e:
                log(f"[discord] sent but failed to cache id: {e}")
        else:
            log("[discord] POST succeeded but no message ID in response")
        _mark_discord_notified()
    except Exception as e:
        log(f"[discord] POST failed: {e}")


def _mark_discord_notified() -> None:
    """bash 側の notify_discord が二重送信しないようマーカーを置く。"""
    try:
        (Path(BASE_DIR) / ".discord_notified_by_python").write_text(
            datetime.utcnow().isoformat() + "\n", encoding="utf-8"
        )
    except Exception:
        pass


def _solve_captcha(page) -> Optional[str]:
    """Grab the base64 CAPTCHA image and run the local Keras solver."""
    MIN_PAYLOAD = 500
    img_src: Optional[str] = None

    # 早期打ち切り: そもそも更新不要ページ (.newApp__suspended) に居るなら
    # CAPTCHA は存在しない。60s の get_attribute タイムアウト暴発を防ぐ。
    try:
        if page.locator(".newApp__suspended").count() > 0:
            log("[captcha] suspended page detected — no CAPTCHA to solve")
            return None
    except Exception:
        pass

    try:
        page.wait_for_selector('img[src^="data:image"]', state="visible", timeout=15_000)
    except Exception as e:
        log(f"[captcha] no image visible: {e}")
        # 15s 待っても img が生えない場合、そもそも <img> が DOM に無いなら
        # 60s タイムアウトを避けるためここで諦める。
        try:
            if page.locator('img[src^="data:image"]').count() == 0:
                log("[captcha] no <img> element at all — aborting solve")
                return None
        except Exception:
            return None

    # Poll for a real, non-empty base64 payload — the site briefly renders an
    # empty img before filling in the actual data URL.
    for _ in range(40):
        try:
            if page.locator('img[src^="data:image"]').count() == 0:
                page.wait_for_timeout(500)
                continue
            cand = page.locator('img[src^="data:image"]').first.get_attribute(
                "src", timeout=1_500
            ) or ""
        except Exception:
            cand = ""
        if cand and "," in cand and len(cand.split(",", 1)[1]) >= MIN_PAYLOAD:
            img_src = cand
            break
        page.wait_for_timeout(500)
    if not img_src:
        log("[captcha] no valid image found")
        return None

    log(f"[captcha] image ready (len={len(img_src)}), solving locally")
    try:
        from captcha_solver import solve as local_solve
    except Exception as e:
        log(f"[captcha] solver unavailable: {e}")
        return None
    try:
        code = local_solve(img_src)
        if code:
            log(f"[captcha] solved: {code}")
            return code
        log("[captcha] solver returned empty")
    except Exception as e:
        log(f"[captcha] solver crashed: {e}")
    return None


# ---------------------------------------------------------------------------
# Renewal flow (imperative, single attempt)
# ---------------------------------------------------------------------------
# run_renewal は (succeeded, status_code, detail) を返す。
#   succeeded : プロセス終了コードに使う bool (True=exit 0)
#   status_code: Discord embed 用のカテゴリ (renewed / not_yet_renewable / ...)
#   detail    : Discord embed に載せる 1〜2 行の説明文
def run_renewal(page, cap: FrameCapture) -> tuple:
    """Return (succeeded, status_code, detail)."""
    log("navigating to login")
    page.goto(LOGIN_URL, wait_until="load", timeout=60_000)
    cap.snap(page, "login_page")

    log("filling credentials")
    email = env_or_prompt("EMAIL", "EMAIL: ")
    password = env_or_prompt("PASSWORD", "PASSWORD: ", secret=True)
    page.locator("#memberid").fill(email)
    page.locator("#user_password").fill(password)
    cap.snap(page, "credentials_filled")
    page.get_by_text("ログインする").click()
    page.wait_for_load_state("domcontentloaded")
    cap.snap(page, "after_login")

    # "Service not contracted" note — nothing to do.
    try:
        note = page.locator(".noteBar--info")
        if note.count() > 0 and "未契約のサービスです" in note.inner_text():
            log("[EXIT] service not contracted")
            return (True, "not_contracted", "未契約のサービスのため何もしません")
    except Exception as e:
        log(f"noteBar check error: {e}")

    # Dismiss the free-user campaign modal if it appears.
    try:
        page.wait_for_selector("#campaignModalForFreeUsers.isOpen", state="visible", timeout=5_000)
        log("dismissing campaign modal")
        page.locator("#campaignModalForFreeUsers button.modal__close").click()
        page.wait_for_selector("#campaignModalForFreeUsers.isOpen", state="hidden", timeout=5_000)
        cap.snap(page, "modal_dismissed")
    except Exception:
        log("no campaign modal")

    log("opening contract menu")
    # メニューのリンクは DOM には常にあるが、ドロップダウン自体は CSS で非表示のことが多い。
    # まず href を直接探して goto する。見つからなければトグルをクリックして見えるようにしてからクリック。
    contract_href = None
    try:
        contract_href = page.evaluate(
            "() => { const a = document.querySelector('.contract__menuList a[href*=\"/xapanel/xvps/server/detail\"]');"
            "        return a ? a.getAttribute('href') : null; }"
        )
    except Exception as e:
        log(f"contract href probe failed: {e}")

    if contract_href:
        log(f"contract link found in DOM: {contract_href}")
        # 完全な URL に変換 (相対パスなら origin を付ける)
        if contract_href.startswith("/"):
            try:
                origin = page.evaluate("() => window.location.origin")
                target_url = origin + contract_href
            except Exception:
                target_url = "https://secure.xserver.ne.jp" + contract_href
        else:
            target_url = contract_href
        page.goto(target_url, wait_until="domcontentloaded", timeout=30_000)
        cap.snap(page, "contract_info")
    else:
        # フォールバック: トグルアイコンをクリックしてメニューを開いてからリンクを探す
        log("contract href not in DOM; falling back to menu click")
        try:
            icon = page.locator(".contract__menuIcon").first
            icon.wait_for(state="visible", timeout=10_000)
            icon.click()
            cap.snap(page, "menu_opened")
        except Exception as e:
            log(f"menu icon click failed: {e}; trying .contract__menu")
            try:
                page.locator(".contract__menu").first.click()
                cap.snap(page, "menu_opened")
            except Exception as e2:
                log(f"menu click also failed: {e2}")

        # 一度 DOM を見直して href を取る
        try:
            contract_href = page.evaluate(
                "() => { const a = document.querySelector('.contract__menuList a[href*=\"/xapanel/xvps/server/detail\"]');"
                "        return a ? a.getAttribute('href') : null; }"
            )
        except Exception:
            contract_href = None

        if contract_href:
            if contract_href.startswith("/"):
                try:
                    origin = page.evaluate("() => window.location.origin")
                    target_url = origin + contract_href
                except Exception:
                    target_url = "https://secure.xserver.ne.jp" + contract_href
            else:
                target_url = contract_href
            log(f"navigating to contract detail: {target_url}")
            page.goto(target_url, wait_until="domcontentloaded", timeout=30_000)
            cap.snap(page, "contract_info")
        else:
            # 最終手段: role=link で探す
            log("still no href; trying role=link fallback")
            page.get_by_role("link", name="契約情報").first.click(timeout=15_000)
            page.wait_for_load_state("domcontentloaded")
            cap.snap(page, "contract_info")

    # 更新する
    try:
        btn = page.get_by_text("更新する")
        btn.wait_for(state="visible", timeout=10_000)
        btn.click()
        cap.snap(page, "update_clicked")
    except Exception:
        log("[EXIT] 更新する button missing — already renewed or unavailable")
        cap.snap(page, "update_unavailable")
        return (True, "already_renewed",
                "『更新する』ボタンが見当たりません。既に更新済みか、更新対象外の可能性があります。")

    # 「更新する」直後に遷移するページで、まだ更新期間に入っていない場合は
    # .newApp__suspended バナーが出る (例: "利用期限の1日前から更新手続きが可能")。
    # ここで検出できれば正常系 (更新不要) として扱う。
    try:
        page.wait_for_load_state("domcontentloaded", timeout=10_000)
    except Exception:
        pass
    suspended_msg = _read_suspended_message(page)
    if suspended_msg:
        log(f"[EXIT] update not available yet (post-更新する): {suspended_msg}")
        cap.snap(page, "suspended_after_update")
        return (True, "not_yet_renewable", suspended_msg)

    # 引き続き無料VPSの利用を継続する
    try:
        btn = page.get_by_text("引き続き無料VPSの利用を継続する")
        btn.wait_for(state="visible", timeout=10_000)
        btn.click()
        cap.snap(page, "continue_flow")
    except Exception:
        log("[EXIT] 継続 button missing")
        cap.snap(page, "continue_unavailable")
        # ボタンが無い場合も、実は suspended バナーが出ているだけかもしれない。
        suspended_msg = _read_suspended_message(page)
        if suspended_msg:
            log(f"[EXIT] continue button missing because suspended: {suspended_msg}")
            return (True, "not_yet_renewable", suspended_msg)
        return (True, "already_renewed",
                "『引き続き無料VPSの利用を継続する』ボタンが見当たりません。")

    # クリック後の遷移を待つ
    try:
        page.wait_for_load_state("domcontentloaded", timeout=10_000)
    except Exception:
        pass
    # Some plans show "not yet renewable" here — treat as success.
    suspended_msg = _read_suspended_message(page)
    if suspended_msg:
        log(f"[EXIT] update not available yet (post-継続): {suspended_msg}")
        cap.snap(page, "suspended")
        return (True, "not_yet_renewable", suspended_msg)

    # ---- CAPTCHA image ----
    cap.snap(page, "before_captcha")
    # CAPTCHA 探索前にもう一度 suspended 判定 (念のため二重防御)
    suspended_msg = _read_suspended_message(page)
    if suspended_msg:
        log(f"[EXIT] suspended detected before CAPTCHA: {suspended_msg}")
        cap.snap(page, "suspended_before_captcha")
        return (True, "not_yet_renewable", suspended_msg)

    code = _solve_captcha(page)
    if not code:
        # CAPTCHA が見つからなかった場合、実は suspended ページに居るだけの可能性もある
        suspended_msg = _read_suspended_message(page)
        if suspended_msg:
            log(f"[EXIT] no CAPTCHA because suspended: {suspended_msg}")
            cap.snap(page, "suspended_no_captcha")
            return (True, "not_yet_renewable", suspended_msg)
        if os.environ.get("CI"):
            log("[FAIL] CI: CAPTCHA unsolved")
            cap.snap(page, "captcha_failed")
            return (False, "captcha_failed", "CAPTCHA画像が取得できないか、解けませんでした。")
        code = input("CAPTCHA: ").strip()

    log("filling CAPTCHA")
    captcha_input = page.locator('[placeholder="上の画像の数字を入力"]')
    captcha_input.click()
    captcha_input.fill("")
    captcha_input.press_sequentially(code, delay=50)
    captcha_input.press("Tab")
    page.wait_for_timeout(500)
    cap.snap(page, "captcha_filled")

    # ---- Cloudflare Turnstile ----
    # Managed Challenge (チェックボックスタイプ) は passive wait だけでは通らないので、
    # token を poll しつつ、必要なら iframe を人間っぽくクリックする。
    log("solving Cloudflare Turnstile…")
    cap.snap(page, "cf_waiting")
    cf_ok = _solve_turnstile(page, cap, max_seconds=30.0)
    cap.snap(page, "cf_done")
    if not cf_ok:
        log("[warn] Turnstile token not observed — submitting anyway")

    # ---- Submit ----
    # Turnstile の callback チェーンが場発火していれば、サイト側 JS が自動で
    # ボタンの disabled を解除する。それを disabled 属性 poll で確認してからクリック。
    # ※ btn--loading は xserver の全ボタンに常時付く装飾クラスなので無視する。
    import random

    submit = page.get_by_role("button", name="無料VPSの利用を継続する").first

    log("waiting for submit button to become enabled…")
    submit_ready = False
    poll_deadline = time.time() + 15.0
    while time.time() < poll_deadline:
        try:
            state = page.evaluate(
                "() => {"
                "  const btns = Array.from(document.querySelectorAll('button, a.btn'));"
                "  const target = btns.find(b => (b.textContent || '').includes('無料VPSの利用を継続する'));"
                "  if (!target) return {found: false};"
                "  const disabled = target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true';"
                "  return {found: true, disabled};"
                "}"
            ) or {}
            if state.get("found") and not state.get("disabled"):
                log(f"[submit] button ready (state={state})")
                submit_ready = True
                break
            log(f"[submit] waiting… state={state}")
        except Exception as e:
            log(f"[submit] state probe failed: {e}")
        time.sleep(0.5)

    # セーフティネット: サイト JS が何らかの理由で発火しなかった場合のみ手動で callback を呼ぶ。
    # force_render でチェーンしているので基本はここには入らないはず。
    if not submit_ready:
        log("[submit] button still disabled — firing site callback as safety net")
        try:
            forced = page.evaluate(
                "() => {"
                "  const result = {steps: []};"
                "  const widget = document.querySelector('.cf-turnstile');"
                "  const cbName = widget ? widget.getAttribute('data-callback') : null;"
                "  result.callbackName = cbName;"
                "  const token = window.__cfToken || '';"
                "  result.hasToken = !!token;"
                "  if (cbName && typeof window[cbName] === 'function' && token) {"
                "    try { window[cbName](token); result.steps.push('called_callback'); }"
                "    catch (e) { result.callbackError = String(e); }"
                "  }"
                "  return result;"
                "}"
            ) or {}
            log(f"[submit] safety-net fire result: {forced}")
        except Exception as e:
            log(f"[submit] safety-net exception: {e}")
        time.sleep(1.5)

    # 少しランダムな pre-click delay
    time.sleep(0.8 + random.random() * 1.2)
    log("submitting")
    _wait_and_click(submit, timeout_ms=15_000)
    cap.snap(page, "submitted")

    # Wait for the server response page.
    try:
        page.wait_for_load_state("domcontentloaded", timeout=30_000)
    except Exception:
        pass
    time.sleep(2)
    cap.snap(page, "result")

    if page.locator("text=認証に失敗しました").count() > 0:
        log("[FAIL] Cloudflare rejected — will retry on next schedule")
        cap.snap(page, "cf_failed")
        return (False, "cf_rejected", "Cloudflareの認証に失敗しました。次回スケジュールで再試行します。")
    if page.locator("text=入力された認証コードが正しくありません").count() > 0:
        log("[FAIL] CAPTCHA wrong — will retry on next schedule")
        cap.snap(page, "captcha_wrong")
        return (False, "captcha_wrong", "CAPTCHAの数値が一致しませんでした。次回スケジュールで再試行します。")

    log("renewal succeeded")
    print("更新操作を送信しました。ブラウザ上の結果を確認してください。")
    return (True, "renewed", "無料VPSの更新手続きを送信しました。")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> int:
    is_ci = os.environ.get("CI") is not None
    headless = _is_headless()
    log(f"runtime: headless={headless}, ci={is_ci}")

    # ---- Skip-until short-circuit ----
    # 前回の実行で「まだ更新不要 (YYYY年M月D日以降)」を受け取っていたら、
    # その日付まで実際のログイン試行はスキップして即 return 0 で終わる。
    # FORCE_RUN=1 を付ければ無視する。
    skip_until = _load_skip_until()
    if skip_until is not None and not _force_run_requested():
        today = _today_jst()
        if today < skip_until:
            log(f"[skip] today={today.isoformat()} < skip_until={skip_until.isoformat()} -> skipping run")
            log("[skip] to force a run anyway, re-invoke with FORCE_RUN=1")
            return 0
        log(f"[skip] today={today.isoformat()} >= skip_until={skip_until.isoformat()} -> proceeding")

    try:
        from cloakbrowser import launch_persistent_context
    except ImportError as e:
        log(f"[FATAL] cloakbrowser not installed: {e}")
        log("        Install with: pip install cloakbrowser cloakbrowser[geoip]")
        return 2

    profile_dir = os.path.join(BASE_DIR, "chromium-profile")
    os.makedirs(profile_dir, exist_ok=True)

    frames_dir = Path(BASE_DIR) / "frames"
    cap = FrameCapture(frames_dir)

    # CloakBrowser launch options.
    # - humanize=True + human_preset="careful": Bézier-curve mouse, per-char
    #   typing, idle micro-movements. Passes Cloudflare's behavioral checks.
    # - launch_persistent_context: keeps cookies + localStorage across runs,
    #   which lets CF trust the profile after the first successful pass and
    #   also avoids incognito-detection penalties.
    # - locale/timezone forced to Japan since the target is a JP-only service.
    # - args: recommended anti-bot flags (per CloakBrowser FingerprintJS docs)
    #   * --fingerprint-noise=false: disable noise injection so ML tampering
    #     detectors don't flag us. Deterministic seed stays active.
    #   * --fingerprint-storage-quota=5000: present as a regular (non-incognito)
    #     profile to detectors that infer incognito from storage quota.
    stealth_args = [
        "--fingerprint-noise=false",
        "--fingerprint-storage-quota=5000",
    ]
    # If Windows fonts are installed under this well-known path, tell the
    # binary to use them so canvas font metrics match Windows.
    win_fonts_dir = os.path.expanduser("~/.local/share/fonts/windows")
    if os.path.isdir(win_fonts_dir):
        stealth_args.append(f"--fingerprint-fonts-dir={win_fonts_dir}")

    launch_kwargs = {
        "headless": headless,
        "humanize": True,
        "human_preset": "careful",
        "locale": "ja-JP",
        "timezone": "Asia/Tokyo",
        "viewport": {"width": 1280, "height": 900},
        "args": stealth_args,
    }
    raw_proxy = os.environ.get("PROXY_SERVER")
    proxy = _normalize_proxy(raw_proxy)
    if proxy and raw_proxy and proxy != raw_proxy.strip():
        log("[proxy] normalized 'host:port:user:pass' style -> standard URL")
    if proxy:
        # プロキシ URL の user:pass 部分はログに出さない
        try:
            from urllib.parse import urlparse
            _p = urlparse(proxy)
            _safe = f"{_p.scheme}://***@{_p.hostname}:{_p.port}"
        except Exception:
            _safe = "(set)"
        log(f"[proxy] PROXY_SERVER active -> {_safe}")
        launch_kwargs["proxy"] = proxy

        # 事前に curl でプロキシ経由の出口 IP を確認する。ここで失敗すれば
        # そもそもトンネルが張れていない/プロキシが上がっていないので
        # ブラウザを起動する前に落とす（ERR_EMPTY_RESPONSE の原因が
        # 一目でわかるようにする）。
        try:
            import subprocess
            r = subprocess.run(
                ["curl", "-sS", "--max-time", "10", "-x", proxy, "https://ifconfig.io"],
                capture_output=True, text=True, timeout=15,
            )
            if r.returncode == 0 and r.stdout.strip():
                exit_ip = r.stdout.strip().splitlines()[-1]
                log(f"[proxy] exit IP via proxy = {exit_ip}")
            else:
                log(f"[proxy] preflight FAILED rc={r.returncode} stderr={r.stderr[:200]!r}")
                log("[proxy] --> \u5bb6PC \u5074\u3067 start.ps1 / tunnel.ps1 \u304c\u8d77\u52d5\u3057\u3066\u3044\u308b\u304b\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044")
                return 3
        except Exception as _pe:
            log(f"[proxy] preflight exception: {_pe}")
            return 3
    else:
        log("[proxy] PROXY_SERVER not set -> \u76f4\u63a5 VPS \u306e IP \u3067\u5916\u306b\u51fa\u307e\u3059 (Cloudflare \u306b\u5f3e\u304b\u308c\u3084\u3059\u3044)")

    license_key = os.environ.get("CLOAKBROWSER_LICENSE_KEY")
    if license_key:
        launch_kwargs["license_key"] = license_key

    succeeded = False
    status_code = "exception"
    detail = ""
    ctx = None
    try:
        ctx = launch_persistent_context(profile_dir, **launch_kwargs)
        ctx.set_default_timeout(60_000)
        ctx.set_default_navigation_timeout(60_000)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        result = run_renewal(page, cap)
        # 後方互換: tuple 以外 (bool 単体) が返っても壊れないようにする
        if isinstance(result, tuple) and len(result) >= 3:
            succeeded, status_code, detail = bool(result[0]), str(result[1]), str(result[2])
        else:
            succeeded = bool(result)
            status_code = "renewed" if succeeded else "exception"
            detail = ""
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        log(f"[FAIL] unhandled exception: {e}")
        # トレースの末尾数行だけ Discord embed に載せる
        tb_tail = "\n".join(tb.rstrip().splitlines()[-6:])
        succeeded = False
        status_code = "exception"
        detail = f"{type(e).__name__}: {e}\n{tb_tail}"
        try:
            if ctx and ctx.pages:
                cap.snap(ctx.pages[0], "exception")
        except Exception:
            pass
    finally:
        cap.finalize()
        if ctx is not None:
            try:
                ctx.close()
            except Exception:
                pass

    rc = 0 if succeeded else 1

    # ---- Skip-until 状態の更新 ----
    # not_yet_renewable の detail 内にある「YYYY年M月D日以降」を state に保存し、
    # 更新完了 / 更新対象外 / 未契約になった場合は state を消す。
    try:
        if status_code == "not_yet_renewable":
            next_date = _parse_next_renewable_date(detail)
            if next_date is not None:
                _save_skip_until(next_date)
            else:
                log("[skip] not_yet_renewable but no date parsed from detail; state left as-is")
        elif status_code in {"renewed", "already_renewed", "not_contracted"}:
            _clear_skip_until()
    except Exception as _se:
        log(f"[skip] state update failed: {_se}")

    # ---- Discord 通知は必ず飛ばす (webhook 未設定なら内部で no-op) ----
    try:
        _notify_discord(rc, status_code, detail)
    except Exception as e:
        log(f"[discord] notify wrapper failed: {e}")

    if not succeeded:
        log(f"[FAIL] flow did not succeed (status={status_code})")
        return rc
    log(f"[OK] flow finished (status={status_code})")
    return rc


if __name__ == "__main__":
    sys.exit(main())
