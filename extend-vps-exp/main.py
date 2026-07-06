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


def _wait_for_cf_token(page, timeout_s: int = 60) -> bool:
    """Poll ``input[name=cf-turnstile-response]`` for a non-empty token.

    CloakBrowser's stealth Chromium usually clears Turnstile automatically
    within a few seconds. Returns True once populated, False on timeout.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            token = page.evaluate(
                "() => { const els = document.querySelectorAll('input[name=\"cf-turnstile-response\"]');"
                "  for (const e of els) { if (e.value && e.value.length > 20) return e.value; }"
                "  return ''; }"
            ) or ""
            if len(token) > 20:
                return True
        except Exception:
            pass
        time.sleep(0.5)
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
    menu = page.locator(".contract__menu").first
    menu.hover()
    menu.click()
    cap.snap(page, "menu_opened")

    page.get_by_role("link", name="契約情報").first.click()
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

    # ---- Cloudflare Turnstile (CloakBrowser handles it natively) ----
    log("waiting for Cloudflare Turnstile token (CloakBrowser)…")
    cap.snap(page, "cf_waiting")
    if _wait_for_cf_token(page, timeout_s=60):
        log("cf token acquired")
        # Let CF finalize (siteverify happens on submit).
        time.sleep(2)
        cap.snap(page, "cf_done")
    else:
        log("[WARN] cf token did not populate — trying submit anyway")
        cap.snap(page, "cf_timeout")

    # ---- Submit ----
    log("submitting")
    submit = page.get_by_role("button", name="無料VPSの利用を継続する").first
    _wait_and_click(submit, timeout_ms=30_000)
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
    launch_kwargs = {
        "headless": headless,
        "humanize": True,
        "human_preset": "careful",
        "locale": "ja-JP",
        "timezone": "Asia/Tokyo",
        "viewport": {"width": 1280, "height": 900},
    }
    proxy = os.environ.get("PROXY_SERVER")
    if proxy:
        launch_kwargs["proxy"] = proxy
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
