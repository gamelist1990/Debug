import os
import shutil
import subprocess
from datetime import datetime
from getpass import getpass
from pathlib import Path
import threading as _threading

# .env loader追加
def load_dotenv(path: str = ".env"):
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = path if os.path.isabs(path) else os.path.join(base_dir, path)

    if not os.path.exists(env_path):
        print(f"[DEBUG] .env not found: {env_path}")
        return

    print(f"[DEBUG] loading .env from: {env_path}")

    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

# 起動時に読み込み（ファイル基準パスに修正）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))


import re as _re
from scrapling.fetchers import StealthyFetcher
from playwright.sync_api import Page
from urllib.request import Request, urlopen
from urllib.request import ProxyHandler, build_opener
import logging

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger(__name__).info

LOGIN_URL = "https://secure.xserver.ne.jp/xapanel/login/xvps/"


class DebugCapture:
    # Live-frame path: overwritten every time capture() is called, plus at the
    # end of each `wait` step in the flow (via update_live()). Always on;
    # independent of DEBUG_VIDEO.
    LIVE_DIR = Path(BASE_DIR) / "frames"
    LIVE_PATH = LIVE_DIR / "live.png"

    def __init__(self, enabled: bool, output_dir: Path):
        self.enabled = enabled
        self.output_dir = output_dir
        self.frames_dir = output_dir / "frames"
        self.events_path = output_dir / "events.log"
        self.video_path = output_dir / "debug.mp4"
        self.frame_index = 0
        self.started = False
        # Ensure the always-on frames dir exists early so update_live() works
        # even before start() is called.
        try:
            self.LIVE_DIR.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

    # ---- Live frame (always on, called from the main thread only) ----
    def update_live(self, page: Page):
        """Overwrite frames/live.png with the current viewport.

        Must be called from the same thread that owns `page` (Playwright's
        sync API is single-threaded). Errors are swallowed so the flow
        keeps running.
        """
        try:
            # Explicit type="png" so Playwright doesn't try to sniff the
            # extension. We write directly to live.png (no .tmp rename)
            # because Playwright rejects unknown extensions.
            page.screenshot(path=str(self.LIVE_PATH), type="png", full_page=False)
        except Exception:
            pass

    # ---- Indexed capture (existing behaviour, gated by DEBUG_VIDEO) ----
    def start(self, page: Page | None = None):
        # Take an immediate live snapshot when we get a page.
        if page is not None:
            self.update_live(page)

        if not self.enabled or self.started:
            return
        self.frames_dir.mkdir(parents=True, exist_ok=True)
        self.events_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_event("capture started (post-login)")
        self.started = True

    def _log_event(self, message: str):
        with open(self.events_path, "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat()} {message}\n")

    def capture(self, page: Page, label: str):
        # Always refresh the live frame, even when DEBUG_VIDEO is off.
        self.update_live(page)

        if not self.enabled or not self.started:
            return

        self.frame_index += 1
        frame_path = self.frames_dir / f"frame_{self.frame_index:05d}.png"
        page.screenshot(path=str(frame_path), full_page=True)
        self._log_event(f"frame={self.frame_index:05d} label={label} path={frame_path.name}")

    def finalize(self):
        if not self.enabled or not self.started:
            return

        ffmpeg_bin = shutil.which("ffmpeg")
        if ffmpeg_bin is None:
            self._log_event("ffmpeg not found; png frames kept as artifact")
            log(f"[DEBUG] ffmpeg not found. Frames are stored at: {self.frames_dir}")
            return

        input_pattern = str(self.frames_dir / "frame_%05d.png")
        cmd = [
            ffmpeg_bin,
            "-y",
            "-framerate",
            "1",
            "-i",
            input_pattern,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(self.video_path),
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            self._log_event(f"video created path={self.video_path}")
            log(f"[DEBUG] video saved: {self.video_path}")
        else:
            self._log_event(f"ffmpeg failed: {result.stderr[:400]}")
            log("[DEBUG] ffmpeg failed; png frames kept as artifact")


def build_debug_capture() -> DebugCapture:
    enabled = os.environ.get("DEBUG_VIDEO", "0").lower() in {"1", "true", "yes", "on"}
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    root = Path(os.environ.get("DEBUG_ARTIFACTS_DIR", str(Path(BASE_DIR) / "artifacts")))
    output_dir = root / f"run_{stamp}"
    return DebugCapture(enabled=enabled, output_dir=output_dir)


def env_or_prompt(name: str, prompt: str, secret: bool = False) -> str:
    value = os.environ.get(name)
    if value:
        return value

    # In CI there is no interactive TTY, so missing env vars must fail fast.
    if os.environ.get("CI"):
        raise RuntimeError(f"Missing required environment variable: {name}")

    if secret:
        return getpass(prompt)

    return input(prompt)


def wait_and_click_enabled(locator, timeout_ms: int = 60000, interval_ms: int = 500):
    elapsed = 0
    while elapsed < timeout_ms:
        if locator.is_visible() and locator.is_enabled():
            locator.click()
            return
        locator.page.wait_for_timeout(interval_ms)
        elapsed += interval_ms

    disabled_attr = locator.get_attribute("disabled")
    aria_disabled_attr = locator.get_attribute("aria-disabled")
    raise TimeoutError(
        "Continue button did not become enabled "
        f"within {timeout_ms}ms (disabled={disabled_attr}, aria-disabled={aria_disabled_attr})"
    )


_flow_result: dict = {"succeeded": False}

def continue_free_vps(page: Page):
    log("start flow")
    debug_capture = build_debug_capture()


    email = env_or_prompt("EMAIL", "EMAIL: ")
    password = env_or_prompt("PASSWORD", "PASSWORD: ", secret=True)

    page.locator("#memberid").fill(email)
    page.locator("#user_password").fill(password)
    page.get_by_text("ログインする").click()
    

    try:
        note = page.locator(".noteBar--info")
        if note.count() > 0:
            text = note.inner_text()
            if "未契約のサービスです" in text:
                log(f"[EXIT] service not contracted -> {text.strip()}")
                return
    except Exception as e:
        log(f"noteBar check error: {e}")


    menu = page.locator(".contract__menu").first
    # Capture starts only after login screen to avoid credential leakage in artifacts.
    # Passing the page also kicks off the always-on live-frame thread
    # (frames/live.png overwritten every 0.5s).
    debug_capture.start(page)
    debug_capture.capture(page, "after_login")

    # Wait for the campaign modal to appear (it renders with a delay after login),
    # then close it. If it doesn't appear within 5 s, skip.
    try:
        page.wait_for_selector("#campaignModalForFreeUsers.isOpen", state="visible", timeout=5000)
        log("campaign modal appeared, clicking close button")
        close_btn = page.locator("#campaignModalForFreeUsers button.modal__close")
        close_btn.click()
        page.wait_for_selector("#campaignModalForFreeUsers.isOpen", state="hidden", timeout=5000)
        log("campaign modal closed")
        debug_capture.capture(page, "modal_dismissed")
    except Exception:
        log("campaign modal did not appear or already closed")

    menu.hover()
    menu.click()
    debug_capture.capture(page, "menu_opened")

    page.get_by_role("link", name="契約情報").first.click()
    debug_capture.capture(page, "contract_info_opened")

    try:
        update_btn = page.get_by_text("更新する")
        update_btn.wait_for(state="visible", timeout=10000)
        update_btn.click()
        debug_capture.capture(page, "update_clicked")
    except Exception:
        log("[EXIT] 更新する button not found - update not available or already done")
        _flow_result["succeeded"] = True
        debug_capture.capture(page, "update_not_available")
        debug_capture.finalize()
        return

    try:
        cont_btn = page.get_by_text("引き続き無料VPSの利用を継続する")
        cont_btn.wait_for(state="visible", timeout=10000)
        cont_btn.click()
        debug_capture.capture(page, "continue_flow_opened")
    except Exception:
        log("[EXIT] 継続ボタン not found - update not available or already done")
        _flow_result["succeeded"] = True
        debug_capture.capture(page, "continue_not_available")
        debug_capture.finalize()
        return

    try:
        suspended = page.locator(".newApp__suspended")
        if suspended.count() > 0:
            text = suspended.inner_text()
            log(f"[EXIT] update not available yet -> {text.strip()}")
            _flow_result["succeeded"] = True
            debug_capture.finalize()
            return
    except Exception as e:
        log(f"suspended check error: {e}")

    # Single-attempt flow:
    #   - CAPTCHA image number: solved by the local Keras model (offline).
    #   - Cloudflare Turnstile: handled by the NopeCHA browser extension
    #     loaded via --load-extension (see main()).
    # No retries: if this attempt fails, tomorrow's cron will retry.
    _succeeded = False
    _prev_img_src = None
    _max_attempts = 1
    for _attempt in range(_max_attempts):
        log(f"captcha attempt {_attempt + 1}/3")
        debug_capture.capture(page, f"before_captcha_a{_attempt + 1}")

        # Wait for a *fresh, non-empty* CAPTCHA image.
        # On retry, the page briefly shows `data:image/jpeg;base64,` (empty payload)
        # before the new image is filled in; we must skip that placeholder.
        img_src = None
        _MIN_PAYLOAD_LEN = 500  # any real base64-encoded captcha is much larger
        try:
            page.wait_for_selector('img[src^="data:image"]', state="visible", timeout=15000)
            # Poll up to ~20s for a NEW *and* non-trivial image.
            for _ in range(40):
                _cand = page.locator('img[src^="data:image"]').first.get_attribute("src") or ""
                if (
                    _cand
                    and _cand != _prev_img_src
                    and len(_cand) >= _MIN_PAYLOAD_LEN
                    and "," in _cand
                    and len(_cand.split(",", 1)[1]) >= _MIN_PAYLOAD_LEN
                ):
                    img_src = _cand
                    break
                page.wait_for_timeout(500)
            if img_src is None:
                _cand = page.locator('img[src^="data:image"]').first.get_attribute("src") or ""
                log(f"captcha image never became fresh (final len={len(_cand)})")
                # Only accept the final candidate if it has a real payload.
                if _cand and "," in _cand and len(_cand.split(",", 1)[1]) >= _MIN_PAYLOAD_LEN:
                    img_src = _cand
        except Exception as _we:
            log(f"captcha image wait failed: {_we}")
            _cand = page.locator('img[src^="data:image"]').first.get_attribute("src") or ""
            if _cand and "," in _cand and len(_cand.split(",", 1)[1]) >= _MIN_PAYLOAD_LEN:
                img_src = _cand

        if img_src:
            log(f"captcha found (len={len(img_src)}), solving locally")
            _prev_img_src = img_src
            code = None

            # Local Keras model only (offline, no remote fallback).
            try:
                from captcha_solver import solve as _local_solve
                _local = _local_solve(img_src)
                if _local:
                    code = _local
                    log(f"captcha solved locally: {code}")
                    debug_capture.capture(page, "captcha_solved_local")
                else:
                    log("local solver returned empty")
            except Exception as _le:
                log(f"local solver unavailable: {_le}")

            if code is None:
                if os.environ.get("CI"):
                    log("CI: local solver failed, aborting attempt")
                    break
                code = input("CAPTCHA: ").strip()
        else:
            log("captcha not found, fallback to manual")
            if os.environ.get("CI"):
                log("CI: no captcha image, aborting attempt")
                break
            code = input("CAPTCHA: ").strip()

        log("fill captcha input")
        captcha_input = page.locator('[placeholder="上の画像の数字を入力"]')
        captcha_input.click()
        captcha_input.fill("")
        captcha_input.press_sequentially(code, delay=50)
        debug_capture.capture(page, "captcha_typing")
        captcha_input.press("Tab")
        page.wait_for_timeout(1000)
        debug_capture.capture(page, "captcha_filled")

        # Cloudflare Turnstile: handled entirely by the NopeCHA browser
        # extension (loaded via --load-extension in main()).
        # We just wait for the extension to fill the cf-turnstile-response
        # hidden input, then continue.
        log("waiting for NopeCHA to solve Cloudflare Turnstile...")
        debug_capture.capture(page, "cloudflare_waiting")

        def _read_token():
            try:
                return page.evaluate(
                    "() => { const els = document.querySelectorAll('input[name=\"cf-turnstile-response\"]');"
                    "  for (const e of els) { if (e.value && e.value.length > 20) return e.value; } return ''; }"
                ) or ""
            except Exception:
                return ""

        token_ok = False
        # Give NopeCHA up to ~60s to click Turnstile and populate the token.
        for _ in range(120):
            if len(_read_token()) > 20:
                token_ok = True
                break
            page.wait_for_timeout(500)

        log(f"cloudflare token acquired via NopeCHA: {token_ok}")
        if token_ok:
            # Small stabilization delay so CF finalizes the token before submit.
            page.wait_for_timeout(2000)
            debug_capture.capture(page, "cloudflare_done")
        else:
            debug_capture.capture(page, "cloudflare_wait_timeout")
            log("[WARN] NopeCHA did not produce a Turnstile token in time; proceeding anyway")

        log("submit final continue button")
        debug_capture.capture(page, "before_submit")
        final_submit = page.get_by_role("button", name="無料VPSの利用を継続する").first
        wait_and_click_enabled(final_submit, timeout_ms=30000)
        debug_capture.capture(page, "final_submit_clicked")

        page.wait_for_timeout(2000)
        debug_capture.capture(page, "result")

        cf_failed = page.locator("text=認証に失敗しました").count() > 0
        captcha_wrong = page.locator("text=入力された認証コードが正しくありません").count() > 0

        if cf_failed or captcha_wrong:
            _kind = "cf_failed" if cf_failed else "captcha_wrong"
            log(f"[FAIL] {_kind} - no retry, will be retried by tomorrow's schedule")
            debug_capture.capture(page, _kind)
            break

        log("auth succeeded")
        _succeeded = True
        _flow_result["succeeded"] = True
        break

    debug_capture.capture(page, "final_state")
    debug_capture.finalize()

    if not _succeeded:
        raise RuntimeError("[FAIL] all authentication attempts failed")

    log("flow completed")
    print("更新操作を送信しました。ブラウザ上の結果を確認してください。")


def main():
    is_ci = os.environ.get("CI") is not None
    headless_env = os.environ.get("HEADLESS")
    if headless_env is None:
        headless = is_ci
    else:
        headless = headless_env.lower() in {"1", "true", "yes", "on"}

    log(f"runtime mode: headless={headless}, ci={is_ci}")

    # NopeCHA extension: solves Cloudflare Turnstile automatically.
    # Path is exported by vps_setup.sh (do_run) after unpacking the CRX.
    nopecha_path = os.environ.get("NOPECHA_EXTENSION_PATH")
    extra_flags = []
    if nopecha_path and os.path.isdir(nopecha_path):
        log(f"loading NopeCHA extension: {nopecha_path}")
        extra_flags = [
            f"--disable-extensions-except={nopecha_path}",
            f"--load-extension={nopecha_path}",
        ]
    else:
        log("NOPECHA_EXTENSION_PATH not set or missing; running without NopeCHA")

    fetch_kwargs = {
        # Extensions require headful Chromium. Xvfb (started by vps_setup.sh)
        # provides the virtual display on headless servers.
        "headless": False if extra_flags else headless,
        "page_action": continue_free_vps,
        # solve_cloudflare is left off because NopeCHA handles Turnstile.
        "solve_cloudflare": False,
        "network_idle": True,
        # StealthyFetcher's timeout is in **milliseconds** (per Scrapling docs).
        # 60_000 ms = 60 s. Previous value of 60 was 60ms and caused instant
        # Page.goto timeouts.
        "timeout": 60_000,
    }
    if extra_flags:
        fetch_kwargs["extra_flags"] = extra_flags
        # Persist the browser profile so the extension retains settings
        # (e.g. NopeCHA API key) between runs.
        _profile_dir = os.path.join(BASE_DIR, "chromium-profile")
        os.makedirs(_profile_dir, exist_ok=True)
        fetch_kwargs["user_data_dir"] = _profile_dir

    proxy_server = os.environ.get("PROXY_SERVER")
    if proxy_server:
        fetch_kwargs["proxy"] = proxy_server

    StealthyFetcher.adaptive = True
    StealthyFetcher.fetch(LOGIN_URL, **fetch_kwargs)

    if not _flow_result.get("succeeded"):
        log("[FAIL] flow did not succeed")
        import sys as _sys
        _sys.exit(1)


if __name__ == "__main__":
    main()