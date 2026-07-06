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

    # ML-based CAPTCHA solving is ~90% accurate at best (this matches the
    # reference upstream at GitHub30/captcha-cloudrun). If attempt 1 is
    # rejected, the site navigates to an error page from which we cannot
    # cleanly recover (POST-navigation go_back fails with ERR_CACHE_MISS,
    # and re-entering the flow times out). Rather than fighting the retry
    # infrastructure, we accept one shot and let tomorrow's schedule retry.
    # In CI we do a single attempt; interactive runs still get 3 attempts.
    _succeeded = False
    _prev_img_src = None
    _max_attempts = 1 if os.environ.get("CI") else 3
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
            log(f"captcha found (len={len(img_src)}, head={img_src[:40]!r}), trying local model first")
            _prev_img_src = img_src
            code = None

            # 1) Local Keras model (offline, no external dependency).
            try:
                from captcha_solver import solve as _local_solve
                _local = _local_solve(img_src)
                if _local:
                    code = _local
                    log(f"captcha solved locally: {code}")
                    debug_capture.capture(page, "captcha_solved_local")
                else:
                    log("local solver returned empty, falling back to remote")
            except Exception as _le:
                log(f"local solver unavailable: {_le}")

            # 2) Remote solver fallback (with retries) if local failed.
            if code is None:
                _proxy_url = os.environ.get("PROXY_SERVER")
                import time as _time
                for _solver_try in range(4):
                    try:
                        req = Request(
                            "https://captcha-120546510085.asia-northeast1.run.app",
                            data=img_src.encode()
                        )
                        if _proxy_url:
                            _opener = build_opener(ProxyHandler({"https": _proxy_url, "http": _proxy_url}))
                            res = _opener.open(req, timeout=20).read().decode().strip()
                        else:
                            res = urlopen(req, timeout=20).read().decode().strip()
                        if res:
                            code = res
                            log(f"captcha solved remotely: {code}")
                            debug_capture.capture(page, "captcha_solved_remote")
                            break
                        log(f"remote solver returned empty (try {_solver_try + 1}/4)")
                    except Exception as e:
                        log(f"remote solve try {_solver_try + 1}/4 failed: {e}")
                    _time.sleep(1 + _solver_try * 2)  # 1s, 3s, 5s, 7s

            if code is None:
                if os.environ.get("CI"):
                    log("CI: both solvers failed, skipping this attempt")
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

        # Click CF Turnstile with human-like mouse movement + token-based success check.
        # Rationale: pure (x+27, y+26) one-shot click under Xvfb triggers CF bot detection.
        # We now: (1) wait for iframe, (2) warm up the pointer with staged moves,
        # (3) move -> mouseDown -> mouseUp on the checkbox, (4) poll cf-turnstile-response token.
        _CF_PAT = _re.compile(r"^https?://challenges\.cloudflare\.com/cdn-cgi/challenge-platform/.*")

        def _human_move(_page, _x, _y, _steps=20):
            _page.mouse.move(_x, _y, steps=_steps)
            _page.wait_for_timeout(120)

        import random as _random
        try:
            # Wait for the outer CF iframe to attach (up to ~15s).
            outer_frame_el = None
            cf_iframe = None
            for _ in range(30):
                cf_iframe = page.frame(url=_CF_PAT)
                if cf_iframe is not None:
                    try:
                        outer_frame_el = cf_iframe.frame_element()
                        if outer_frame_el is not None:
                            break
                    except Exception:
                        pass
                page.wait_for_timeout(500)

            if outer_frame_el is None:
                log("cloudflare iframe not found")
            else:
                # Scroll the widget into view first (mimics user reading the form).
                try:
                    outer_frame_el.scroll_into_view_if_needed()
                    page.wait_for_timeout(300)
                except Exception:
                    pass

                # Warm up the mouse with random jitter from arbitrary start point.
                vp = page.viewport_size or {"width": 1280, "height": 900}
                _sx = _random.randint(80, max(120, vp["width"] // 2))
                _sy = _random.randint(80, max(120, vp["height"] // 3))
                _human_move(page, _sx, _sy, _steps=12)
                _human_move(page, _sx + _random.randint(-40, 40), _sy + _random.randint(-30, 30), _steps=8)

                box = outer_frame_el.bounding_box()
                if box:
                    # Turnstile checkbox sits ~27px right, ~28px down inside the widget.
                    target_x = box["x"] + 27 + _random.uniform(-2, 2)
                    target_y = box["y"] + 28 + _random.uniform(-2, 2)
                    # Diagonal approach with two waypoints.
                    _human_move(page, target_x - 80, target_y - 30, _steps=20)
                    page.wait_for_timeout(_random.randint(120, 260))
                    _human_move(page, target_x - 15, target_y - 8, _steps=12)
                    page.wait_for_timeout(_random.randint(80, 180))
                    _human_move(page, target_x, target_y, _steps=6)
                    page.wait_for_timeout(_random.randint(60, 140))
                    # Attempt 1: raw mouse click.
                    page.mouse.down()
                    page.wait_for_timeout(_random.randint(70, 130))
                    page.mouse.up()
                    log(f"cloudflare clicked at ({target_x:.0f},{target_y:.0f})")
                    debug_capture.capture(page, "cloudflare_clicked")

                    # Poll for token up to ~25s.
                    def _read_token():
                        try:
                            return page.evaluate(
                                "() => { const els = document.querySelectorAll('input[name=\"cf-turnstile-response\"]');"
                                "  for (const e of els) { if (e.value && e.value.length > 20) return e.value; } return ''; }"
                            ) or ""
                        except Exception:
                            return ""

                    token_ok = False
                    for _ in range(50):
                        if len(_read_token()) > 20:
                            token_ok = True
                            break
                        page.wait_for_timeout(500)

                    # Fallback: click the inner checkbox via frame_locator if raw click did not produce a token.
                    if not token_ok:
                        log("cloudflare token not yet, trying inner-frame checkbox click")
                        debug_capture.capture(page, "cloudflare_retry_inner")
                        try:
                            fl = page.frame_locator('iframe[src*="challenges.cloudflare.com/cdn-cgi/challenge-platform"]')
                            # Try common Turnstile selectors.
                            for _sel in ["input[type=checkbox]", "label", "#challenge-stage", "body"]:
                                try:
                                    fl.locator(_sel).first.click(timeout=3000, force=True)
                                    log(f"inner-frame click via {_sel} succeeded")
                                    break
                                except Exception as _iexc:
                                    log(f"inner-frame click via {_sel} failed: {_iexc}")
                        except Exception as _fexc:
                            log(f"inner-frame fallback error: {_fexc}")
                        # Poll once more.
                        for _ in range(30):
                            if len(_read_token()) > 20:
                                token_ok = True
                                break
                            page.wait_for_timeout(500)

                    log(f"cloudflare token acquired: {token_ok}")
                    debug_capture.capture(page, "cloudflare_done" if token_ok else "cloudflare_wait_timeout")
                else:
                    log("cloudflare iframe bounding box not available")
        except Exception as _cf_err:
            log(f"cloudflare click error: {_cf_err}")

        log("submit final continue button")
        debug_capture.capture(page, "before_submit")
        final_submit = page.get_by_role("button", name="無料VPSの利用を継続する").first
        wait_and_click_enabled(final_submit, timeout_ms=30000)
        debug_capture.capture(page, "final_submit_clicked")

        page.wait_for_timeout(2000)
        debug_capture.capture(page, f"result_a{_attempt + 1}")

        cf_failed = page.locator("text=認証に失敗しました").count() > 0
        captcha_wrong = page.locator("text=入力された認証コードが正しくありません").count() > 0

        if cf_failed or captcha_wrong:
            _kind = "cf_failed" if cf_failed else "captcha_wrong"
            log(f"{_kind} on attempt {_attempt + 1}, going back to captcha form")
            debug_capture.capture(page, f"{_kind}_a{_attempt + 1}")
            # The error page has no captcha form; navigate back to reach the form again.
            try:
                page.go_back(wait_until="domcontentloaded", timeout=15000)
                page.wait_for_timeout(1500)
            except Exception as _be:
                log(f"go_back failed: {_be}")
            # If the form isn't there, click the update flow again.
            if page.locator('[placeholder="上の画像の数字を入力"]').count() == 0:
                log("captcha form missing after go_back, re-entering flow")
                try:
                    _btn = page.get_by_text("更新する")
                    _btn.wait_for(state="visible", timeout=8000)
                    _btn.click()
                    _cont = page.get_by_text("引き続き無料VPSの利用を継続する")
                    _cont.wait_for(state="visible", timeout=10000)
                    _cont.click()
                except Exception as _reenter_err:
                    log(f"re-enter flow failed: {_reenter_err}")
            # Wait for the CAPTCHA input to reappear before next attempt starts polling image.
            try:
                page.wait_for_selector('[placeholder="上の画像の数字を入力"]', timeout=15000)
            except Exception:
                log("captcha input did not reappear")
            page.wait_for_timeout(1000)
            continue
        elif False:  # legacy branch retained for structure; both handled above
            log(f"CAPTCHA code wrong on attempt {_attempt + 1}, retrying")
            debug_capture.capture(page, f"captcha_wrong_a{_attempt + 1}")
            page.wait_for_timeout(1000)
            continue

        log("auth succeeded")
        _succeeded = True
        _flow_result["succeeded"] = True
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

    if not _flow_result.get("succeeded"):
        log("[FAIL] flow did not succeed")
        import sys as _sys
        _sys.exit(1)


if __name__ == "__main__":
    main()