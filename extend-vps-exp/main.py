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


# Turnstile widget / iframe を探すセレクタ群。後ろだと弱い候補になるように並べている。
_TURNSTILE_SELECTORS = [
    "iframe[src*='challenges.cloudflare.com']",
    "iframe[src*='turnstile']",
    "iframe[title*='Cloudflare']",
    "iframe[title*='Widget containing']",
    "iframe[title*='challenge']",
    ".cf-turnstile",
    "[data-sitekey]",
]


def _find_turnstile_element(page):
    """Turnstile widget を見つけて (element, selector) を返す。"""
    for sel in _TURNSTILE_SELECTORS:
        try:
            el = page.query_selector(sel)
            if el:
                # サイズが 0 の widget は隠しフィールドなのでスキップ
                box = el.bounding_box()
                if box and box.get("width", 0) >= 20 and box.get("height", 0) >= 20:
                    return el, sel
        except Exception:
            continue
    return None, None


# 後方互換のためのエイリアス
def _find_turnstile_iframe(page):
    el, _ = _find_turnstile_element(page)
    return el


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
            "  window.__cfToken = '';"
            "  window.__cfError = '';"
            "  window.__cfWidgetId = '';"
            "  try {"
            "    /* 既存の render を削除してクリーンな状態にする */"
            "    try { widget.innerHTML = ''; } catch(_){}"
            "    const opts = {"
            "      sitekey: sitekey,"
            "      callback: (t) => { window.__cfToken = t; },"
            "      'error-callback': (e) => { window.__cfError = String(e); },"
            "      'expired-callback': () => { window.__cfToken = ''; },"
            "    };"
            "    /* サイト側が invisible を期待してる場合に備えて size を採用 */"
            "    const dataSize = widget.getAttribute('data-size');"
            "    if (dataSize) opts.size = dataSize;"
            "    const id = window.turnstile.render(widget, opts);"
            "    window.__cfWidgetId = String(id);"
            "    return {ok:true, id: String(id), size: dataSize||'normal'};"
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


def _try_execute_invisible_turnstile(page, widget_id: str) -> None:
    """invisible mode の Turnstile は render だけでは発火せず、
    turnstile.execute() を明示的に呼ばないと token が生えない。
    """
    try:
        result = page.evaluate(
            "(id) => {"
            "  try {"
            "    if (id && typeof window.turnstile.execute === 'function') {"
            "      window.turnstile.execute(id);"
            "      return {ok:true, mode:'id'};"
            "    }"
            "    const widget = document.querySelector('.cf-turnstile');"
            "    if (widget && typeof window.turnstile.execute === 'function') {"
            "      window.turnstile.execute(widget);"
            "      return {ok:true, mode:'widget'};"
            "    }"
            "    return {ok:false, reason:'no_execute'};"
            "  } catch (e) { return {ok:false, err:String(e)}; }"
            "}",
            widget_id or "",
        )
        log(f"[cf] execute() result: {result}")
    except Exception as e:
        log(f"[cf] execute exception: {e}")


def _read_cf_token_all(page) -> str:
    """callback ・window.__cfToken・getResponse()・隠し input を全部見てトークンを探す。"""
    # 1. callback で保存されたトークン
    try:
        t = page.evaluate("() => window.__cfToken || ''") or ""
        if t and len(t) > 20:
            return t
    except Exception:
        pass
    # 2. turnstile.getResponse(widgetId) or getResponse()
    try:
        t = page.evaluate(
            "() => {"
            "  if (typeof window.turnstile === 'undefined') return '';"
            "  try { const r = window.turnstile.getResponse(window.__cfWidgetId || undefined); if (r) return r; } catch(_){}"
            "  try { const r = window.turnstile.getResponse(); if (r) return r; } catch(_){}"
            "  return '';"
            "}"
        ) or ""
        if t and len(t) > 20:
            return t
    except Exception:
        pass
    # 3. 隠し input
    return _read_turnstile_token(page)


def _propagate_cf_token(page, token: str) -> None:
    """取得した token をページ内のすべての cf-turnstile-response input に入れる。"""
    try:
        page.evaluate(
            "(t) => { document.querySelectorAll('input[name=\"cf-turnstile-response\"]').forEach(e => { e.value = t; e.dispatchEvent(new Event('change', {bubbles: true})); }); }",
            token,
        )
    except Exception:
        pass


def _try_inject_turnstile_script(page) -> bool:
    """Turnstile の api.js がロードされてないなら注入する。"""
    try:
        result = page.evaluate(
            "() => new Promise((resolve) => {"
            "  if (typeof window.turnstile !== 'undefined') { resolve({ok:true, already:true}); return; }"
            "  const existing = document.querySelector('script[src*=\"turnstile\"]');"
            "  if (existing) { resolve({ok:true, existing:true}); return; }"
            "  const s = document.createElement('script');"
            "  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';"
            "  s.async = true; s.defer = true;"
            "  s.onload = () => resolve({ok:true, loaded:true});"
            "  s.onerror = (e) => resolve({ok:false, err:'load_failed'});"
            "  document.head.appendChild(s);"
            "  setTimeout(() => resolve({ok:false, err:'timeout'}), 10000);"
            "})"
        )
        log(f"[cf] inject api.js result: {result}")
        return bool(result and result.get("ok"))
    except Exception as e:
        log(f"[cf] inject exception: {e}")
        return False


# scrapling 流: CF challenge iframe は document.querySelectorAll('iframe') では
# 見えないことがある (Shadow iframe / closed frame)。page.frame(url=regex) だけ
# が見つけられる。
_CF_FRAME_URL_PATTERN = re.compile(r"^https?://challenges\.cloudflare\.com/cdn-cgi/challenge-platform/.*")

# Turnstile widget の内側 div を探すセレクタ (scrapling 流)
# .cf-turnstile > div > div が実際のチェックボックスを含む内側ボックス
_CF_INNER_BOX_SELECTORS = [
    "#cf_turnstile div",
    "#cf-turnstile div",
    ".cf-turnstile > div > div",
    ".turnstile > div > div",
]


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

    優先順:
      1. page.frame(url=CF_PATTERN) で iframe を探して、その frame_element の
         bounding_box に対してクリック (scrapling 流)
      2. 内側 div セレクタ (.cf-turnstile > div > div 等) で探す
      3. 後方互換: 外側 .cf-turnstile div の左上
    """
    # (1) Playwright frame API で CF iframe を探す
    try:
        cf_frame = _find_cf_challenge_frame(page)
        if cf_frame:
            try:
                frame_element = cf_frame.frame_element()
                box = frame_element.bounding_box()
                if box and box.get("width", 0) >= 20:
                    # scrapling と同じ offset: (26~28, 25~27)px
                    import random as _random
                    target_x = box["x"] + _random.randint(26, 28)
                    target_y = box["y"] + _random.randint(25, 27)
                    log(f"[cf] CF frame found via page.frame(url=), box={box}, clicking ({target_x:.0f}, {target_y:.0f})")
                    # 人間っぽいアプローチ
                    page.mouse.move(target_x - 60, target_y - 20, steps=15)
                    time.sleep(0.15)
                    page.mouse.move(target_x, target_y, steps=10)
                    time.sleep(0.1)
                    # click with delay (scrapling 流)
                    page.mouse.click(target_x, target_y, delay=_random.randint(100, 200), button="left")
                    return True
            except Exception as e:
                log(f"[cf] frame_element bounding_box failed: {e}")
    except Exception as e:
        log(f"[cf] frame lookup exception: {e}")

    # (2) 内側 div セレクタで探す
    for sel in _CF_INNER_BOX_SELECTORS:
        try:
            el = page.query_selector(sel)
            if not el:
                continue
            try:
                el.scroll_into_view_if_needed(timeout=2000)
                time.sleep(0.2)
            except Exception:
                pass
            box = el.bounding_box()
            if not box or box.get("width", 0) < 20:
                continue
            import random as _random
            target_x = box["x"] + _random.randint(26, 28)
            target_y = box["y"] + _random.randint(25, 27)
            log(f"[cf] inner box found via {sel!r}, box={box}, clicking ({target_x:.0f}, {target_y:.0f})")
            page.mouse.move(target_x - 60, target_y - 20, steps=15)
            time.sleep(0.15)
            page.mouse.move(target_x, target_y, steps=10)
            time.sleep(0.1)
            page.mouse.click(target_x, target_y, delay=_random.randint(100, 200), button="left")
            return True
        except Exception as e:
            log(f"[cf] inner selector {sel!r} exception: {e}")
            continue

    # (3) フォールバック: 外側 .cf-turnstile div の左上をクリック
    try:
        el, sel = _find_turnstile_element(page)
        if not el:
            return False
        try:
            el.scroll_into_view_if_needed(timeout=3000)
            time.sleep(0.3)
        except Exception:
            pass
        box = el.bounding_box()
        if not box or box.get("width", 0) < 20:
            return False
        import random as _random
        target_x = box["x"] + _random.randint(26, 28)
        target_y = box["y"] + _random.randint(25, 27)
        log(f"[cf] fallback outer widget {sel!r}, box={box}, clicking ({target_x:.0f}, {target_y:.0f})")
        page.mouse.move(target_x - 60, target_y - 20, steps=15)
        time.sleep(0.15)
        page.mouse.move(target_x, target_y, steps=10)
        time.sleep(0.1)
        page.mouse.click(target_x, target_y, delay=_random.randint(100, 200), button="left")
        return True
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
        log("[cf] iframe is missing — attempting recovery (likely invisible mode)")
        _snap("cf_iframe_missing")
        # (1) api.js がないなら入れる
        _try_inject_turnstile_script(page)
        time.sleep(2.0)
        # (2) window.turnstile.render() を手動で呼ぶ
        widget_id = _try_force_render_turnstile(page)
        if widget_id is not None:
            log(f"[cf] force-render succeeded (widget id={widget_id!r})")
            _snap("cf_after_render")
            # (3) invisible mode を想定して execute() を明示的に呼ぶ
            time.sleep(1.0)
            _try_execute_invisible_turnstile(page, widget_id)
            _snap("cf_after_execute")
            # (4) 15s poll: callback / getResponse / input を全方位で探す
            wait_end = min(deadline, time.time() + 15.0)
            while time.time() < wait_end:
                token = _read_cf_token_all(page)
                if token:
                    log(f"[cf] token acquired after force-render+execute (len={len(token)})")
                    _propagate_cf_token(page, token)
                    _snap("cf_token_render")
                    return True
                # エラーが発生してたらログに出して抜ける
                try:
                    err = page.evaluate("() => window.__cfError || ''")
                    if err:
                        log(f"[cf] error-callback fired: {err}")
                        _snap("cf_error_callback")
                        break
                except Exception:
                    pass
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


def _solve_captcha(page) -> Optional[str]:
    """Grab the base64 CAPTCHA image and run the local Keras solver."""
    MIN_PAYLOAD = 500
    img_src: Optional[str] = None
    try:
        page.wait_for_selector('img[src^="data:image"]', state="visible", timeout=15_000)
    except Exception as e:
        log(f"[captcha] no image visible: {e}")

    # Poll for a real, non-empty base64 payload — the site briefly renders an
    # empty img before filling in the actual data URL.
    for _ in range(40):
        cand = page.locator('img[src^="data:image"]').first.get_attribute("src") or ""
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
def run_renewal(page, cap: FrameCapture) -> bool:
    """Return True if the renewal succeeded (or was not needed), False otherwise."""
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
            return True
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
        return True

    # 引き続き無料VPSの利用を継続する
    try:
        btn = page.get_by_text("引き続き無料VPSの利用を継続する")
        btn.wait_for(state="visible", timeout=10_000)
        btn.click()
        cap.snap(page, "continue_flow")
    except Exception:
        log("[EXIT] 継続 button missing")
        cap.snap(page, "continue_unavailable")
        return True

    # Some plans show "not yet renewable" here — treat as success.
    try:
        suspended = page.locator(".newApp__suspended")
        if suspended.count() > 0:
            log(f"[EXIT] update not available yet: {suspended.inner_text().strip()}")
            cap.snap(page, "suspended")
            return True
    except Exception as e:
        log(f"suspended check error: {e}")

    # ---- CAPTCHA image ----
    cap.snap(page, "before_captcha")
    code = _solve_captcha(page)
    if not code:
        if os.environ.get("CI"):
            log("[FAIL] CI: CAPTCHA unsolved")
            cap.snap(page, "captcha_failed")
            return False
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
    # Turnstile の token が取れても、ページ側 JS が token を検知して submit
    # ボタンを enable にするまでにタイムラグがある。disabled / aria-disabled /
    # スピナー (.btn--loading の running 状態) をチェックしてボタンが本当に
    # 押せる状態になってからクリックする。
    import random

    submit = page.get_by_role("button", name="無料VPSの利用を継続する").first

    # ※ btn--loading は xserver の全ボタンに常時付いている装飾クラスで、
    #   「loading 中」を意味しない。disabled 属性だけ見る。
    log("waiting for submit button to become truly enabled…")
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
                "  const rect = target.getBoundingClientRect();"
                "  return {found: true, disabled, cls: target.className||'', tag: target.tagName, w: rect.width, h: rect.height};"
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

    if not submit_ready:
        log("[submit] button still disabled — attempting forced enable + callback trigger")
        try:
            forced = page.evaluate(
                "() => {"
                "  const result = {steps: []};"
                "  const btns = Array.from(document.querySelectorAll('button, a.btn'));"
                "  const target = btns.find(b => (b.textContent || '').includes('無料VPSの利用を継続する'));"
                "  if (!target) return {ok:false, reason:'no_target'};"
                "  /* (1) widget の data-callback を探して呼んでみる */"
                "  const widget = document.querySelector('.cf-turnstile');"
                "  const cbName = widget ? widget.getAttribute('data-callback') : null;"
                "  result.callbackName = cbName;"
                "  const token = window.__cfToken || '';"
                "  if (cbName && typeof window[cbName] === 'function' && token) {"
                "    try { window[cbName](token); result.steps.push('called_callback'); } catch (e) { result.callbackError = String(e); }"
                "  }"
                "  /* (2) disabled を強制的に外す */"
                "  target.removeAttribute('disabled');"
                "  target.removeAttribute('aria-disabled');"
                "  result.steps.push('removed_disabled');"
                "  /* (3) form があれば 直接 submit する選択肢もログに残す */"
                "  const form = target.closest('form');"
                "  result.hasForm = !!form;"
                "  return {ok:true, ...result};"
                "}"
            ) or {}
            log(f"[submit] forced enable result: {forced}")
        except Exception as e:
            log(f"[submit] forced enable failed: {e}")

        # (4) 強制 enable にした後、もう一度 disabled が外れたか確認
        time.sleep(1.5)
        try:
            recheck = page.evaluate(
                "() => {"
                "  const btns = Array.from(document.querySelectorAll('button, a.btn'));"
                "  const target = btns.find(b => (b.textContent || '').includes('無料VPSの利用を継続する'));"
                "  if (!target) return {found:false};"
                "  return {found:true, disabled: target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true'};"
                "}"
            ) or {}
            log(f"[submit] after force: {recheck}")
            if recheck.get("found") and not recheck.get("disabled"):
                submit_ready = True
        except Exception:
            pass

    # 少しランダムな pre-click delay
    time.sleep(0.8 + random.random() * 1.2)
    log("submitting")

    click_ok = False
    try:
        _wait_and_click(submit, timeout_ms=15_000)
        click_ok = True
    except Exception as e:
        log(f"[submit] normal click failed: {e}")

    if not click_ok:
        # フォールバック: JS で click() / form.submit()
        log("[submit] fallback: JS click() then form.submit()")
        try:
            js_result = page.evaluate(
                "() => {"
                "  const btns = Array.from(document.querySelectorAll('button, a.btn'));"
                "  const target = btns.find(b => (b.textContent || '').includes('無料VPSの利用を継続する'));"
                "  if (!target) return {ok:false, reason:'no_target'};"
                "  target.removeAttribute('disabled');"
                "  try { target.click(); return {ok:true, via:'click'}; } catch (e) { }"
                "  const form = target.closest('form');"
                "  if (form) { form.submit(); return {ok:true, via:'form.submit'}; }"
                "  return {ok:false, reason:'no_form'};"
                "}"
            )
            log(f"[submit] JS fallback result: {js_result}")
        except Exception as e:
            log(f"[submit] JS fallback exception: {e}")

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
        return False
    if page.locator("text=入力された認証コードが正しくありません").count() > 0:
        log("[FAIL] CAPTCHA wrong — will retry on next schedule")
        cap.snap(page, "captcha_wrong")
        return False

    log("renewal succeeded")
    print("更新操作を送信しました。ブラウザ上の結果を確認してください。")
    return True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> int:
    is_ci = os.environ.get("CI") is not None
    headless = _is_headless()
    log(f"runtime: headless={headless}, ci={is_ci}")

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
    ctx = None
    try:
        ctx = launch_persistent_context(profile_dir, **launch_kwargs)
        ctx.set_default_timeout(60_000)
        ctx.set_default_navigation_timeout(60_000)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        succeeded = run_renewal(page, cap)
    except Exception as e:
        log(f"[FAIL] unhandled exception: {e}")
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

    if not succeeded:
        log("[FAIL] flow did not succeed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
