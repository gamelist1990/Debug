import os
from getpass import getpass

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


from scrapling.fetchers import StealthyFetcher
from playwright.sync_api import Page
from urllib.request import Request, urlopen
import logging

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger(__name__).info

LOGIN_URL = "https://secure.xserver.ne.jp/xapanel/login/xvps/"


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
    menu.hover()
    menu.click()

    page.get_by_role("link", name="契約情報").first.click()

    page.get_by_text("更新する").click()

    page.get_by_text("引き続き無料VPSの利用を継続する").click()

    try:
        suspended = page.locator(".newApp__suspended")
        if suspended.count() > 0:
            text = suspended.inner_text()
            log(f"[EXIT] update not available yet -> {text.strip()}")
            return
    except Exception as e:
        log(f"suspended check error: {e}")

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
        except Exception as e:
            log(f"captcha solve failed: {e}")
            code = input("CAPTCHA: ").strip()
    else:
        log("captcha not found, fallback to manual")
        code = input("CAPTCHA: ").strip()

    log("fill captcha input")
    captcha_input = page.locator('[placeholder="上の画像の数字を入力"]')
    captcha_input.fill(code)
    # Some pages enable submit only after blur/input events are processed.
    captcha_input.press("Tab")

    log("submit final continue button")
    final_submit = page.get_by_role("button", name="無料VPSの利用を継続する").first
    wait_and_click_enabled(final_submit)

    log("waiting final result")

    log("flow completed")
    print("更新操作を送信しました。ブラウザ上の結果を確認してください。")


def main():
    is_ci = os.environ.get("CI") is not None
    fetch_kwargs = {
        "headless": is_ci,
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