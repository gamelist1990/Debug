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
import logging

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger(__name__).info

LOGIN_URL = "https://secure.xserver.ne.jp/xapanel/login/xvps/"


class DebugCapture:
    def __init__(self, enabled: bool, output_dir: Path):
        self.enabled = enabled
        self.output_dir = output_dir
        self.frames_dir = output_dir / "frames"
        self.events_path = output_dir / "events.log"
        self.video_path = output_dir / "debug.mp4"
        self.frame_index = 0
        self.started = False

    def start(self):
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
    debug_capture.start()
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

    page.get_by_text("更新する").click()
    debug_capture.capture(page, "update_clicked")

    page.get_by_text("引き続き無料VPSの利用を継続する").click()
    debug_capture.capture(page, "continue_flow_opened")

    try:
        suspended = page.locator(".newApp__suspended")
        if suspended.count() > 0:
            text = suspended.inner_text()
            log(f"[EXIT] update not available yet -> {text.strip()}")
            return
    except Exception as e:
        log(f"suspended check error: {e}")

    _succeeded = False
    for _attempt in range(3):
        log(f"captcha attempt {_attempt + 1}/3")
        debug_capture.capture(page, f"before_captcha_a{_attempt + 1}")
        img_src = page.locator('img[src^="data:"]').get_attribute("src")

        if img_src:
            log("captcha found, sending to solver")
            try:
                req = Request(
                    "https://captcha-120546510085.asia-northeast1.run.app",
                    data=img_src.encode()
                )
                res = urlopen(req).read().decode().strip()
                code = res
                log(f"captcha solved: {code}")
                debug_capture.capture(page, "captcha_solved")
            except Exception as e:
                log(f"captcha solve failed: {e}")
                if os.environ.get("CI"):
                    log("CI: solver failed, skipping this attempt")
                    continue
                code = input("CAPTCHA: ").strip()
        else:
            log("captcha not found, fallback to manual")
            if os.environ.get("CI"):
                log("CI: no captcha image, skipping")
                continue
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

        # Use the same method as Scrapling's _cloudflare_solver:
        # find the CF iframe by URL pattern and click via bounding box coordinates.
        _CF_PAT = _re.compile(r"^https?://challenges\.cloudflare\.com/cdn-cgi/challenge-platform/.*")
        try:
            cf_iframe = page.frame(url=_CF_PAT)
            if cf_iframe is not None:
                outer_box = cf_iframe.frame_element().bounding_box()
                if outer_box:
                    cx = outer_box["x"] + 27
                    cy = outer_box["y"] + 26
                    page.mouse.click(cx, cy, delay=150)
                    log(f"cloudflare iframe clicked at ({cx:.0f},{cy:.0f}), waiting")
                    debug_capture.capture(page, "cloudflare_clicked")
                    page.wait_for_timeout(5000)
                    debug_capture.capture(page, "cloudflare_done")
                else:
                    log("cloudflare iframe found but no bounding box")
            else:
                log("cloudflare iframe not found by URL pattern")
        except Exception as _cf_err:
            log(f"cloudflare click error: {_cf_err}")

        log("submit final continue button")
        final_submit = page.get_by_role("button", name="無料VPSの利用を継続する").first
        debug_capture.capture(page, "before_submit")
        wait_and_click_enabled(final_submit)
        debug_capture.capture(page, "final_submit_clicked")

        page.wait_for_timeout(2000)
        debug_capture.capture(page, f"result_a{_attempt + 1}")

        cf_failed = page.locator("text=認証に失敗しました").count() > 0
        captcha_wrong = page.locator("text=入力された認証コードが正しくありません").count() > 0

        if cf_failed:
            log(f"Cloudflare auth failed on attempt {_attempt + 1}, retrying")
            debug_capture.capture(page, f"cf_failed_a{_attempt + 1}")
            page.wait_for_timeout(2000)
            try:
                page.wait_for_selector('img[src^="data:image"]', timeout=10000)
            except Exception:
                log("captcha image did not reload")
            continue
        elif captcha_wrong:
            log(f"CAPTCHA code wrong on attempt {_attempt + 1}, retrying")
            debug_capture.capture(page, f"captcha_wrong_a{_attempt + 1}")
            page.wait_for_timeout(1000)
            continue

        log("auth succeeded")
        _succeeded = True
        break
    else:
        log("all captcha attempts exhausted")

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

    fetch_kwargs = {
        "headless": headless,
        "page_action": continue_free_vps,
        "solve_cloudflare": True,
        "network_idle": True,
        "timeout": 60
    }

    proxy_server = os.environ.get("PROXY_SERVER")
    if proxy_server:
        fetch_kwargs["proxy"] = proxy_server

    StealthyFetcher.adaptive = True
    StealthyFetcher.fetch(LOGIN_URL, **fetch_kwargs)


if __name__ == "__main__":
    main()