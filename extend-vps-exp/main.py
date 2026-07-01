import os
from getpass import getpass

# .env loader追加
def load_dotenv(path: str = ".env"):
    # ファイル基準の絶対パスに変換
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, path)

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

    if secret:
        return getpass(prompt)

    return input(prompt)


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


    # メニューを開いてから契約情報をクリック（hidden対策）
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

    # CAPTCHA自動取得（main.mjs 相当）
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
    page.locator('[placeholder="上の画像の数字を入力"]').fill(code)

    log("submit final continue button")
    page.get_by_text("無料VPSの利用を継続する").click()

    log("waiting final result")

    log("flow completed")
    print("更新操作を送信しました。ブラウザ上の結果を確認してください。")


def main():
    fetch_kwargs = {
        "headless": False,
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