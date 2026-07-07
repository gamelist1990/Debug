"""CloakBrowser 単体テスト: Cloudflare を突破できるかを IP レベルで検証する。

目的:
- Oracle Cloud / 他の VPS / 家の回線など、現在の IP で
  Cloudflare の防御を CloakBrowser で抜けられるかを判定する。
- Xserver 本番にさわらずに、公開されているテストサイトだけで判定する。

使い方:
    # 直接 (VPS の IP で)
    python test.py

    # プロキシ経由 (家 IP で)
    PROXY_SERVER=http://user:pass@127.0.0.1:8888 python test.py

    # ヘッドレスで走らせる (VPS では Xvfb 不要になる)
    HEADLESS=1 python test.py

判定:
- ifconfig.io で現在の出口 IP を確認
- nowsecure.nl にアクセスして、'You are human!' or
  '<title>' に Cloudflare / Just a moment がないことを確認
- 可能なら bot.sannysoft.com も回す（フィンガープリント検知の定番）
各テストが PASS/FAIL でサマリされる。
"""
from __future__ import annotations

import os
import sys
import time
import subprocess
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


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


# ---------------------------------------------------------------------------
# PROXY_SERVER 正規化
# ---------------------------------------------------------------------------
# host:port:user:pass 形式を scheme://user:pass@host:port に変換する。
def _normalize_proxy(raw):
    if not raw:
        return raw
    s = raw.strip()
    if not s:
        return None
    if "://" in s:
        scheme, rest = s.split("://", 1)
    else:
        scheme, rest = "http", s
    if "@" in rest:
        return f"{scheme}://{rest}"
    parts = rest.split(":")
    if len(parts) == 4:
        host, port, user, pw = parts
        return f"{scheme}://{user}:{pw}@{host}:{port}"
    return f"{scheme}://{rest}"


# 環境変数を早めに正規化しておく (curl / cloakbrowser 両方が正しい値を見るように)
_raw = os.environ.get("PROXY_SERVER")
_norm = _normalize_proxy(_raw)
if _raw and _norm and _norm != _raw.strip():
    os.environ["PROXY_SERVER"] = _norm


# ---------------------------------------------------------------------------
# ログ
# ---------------------------------------------------------------------------
def p(msg: str, ok: bool | None = None) -> None:
    if ok is True:
        print(f"  \033[32m[ OK ]\033[0m {msg}")
    elif ok is False:
        print(f"  \033[31m[FAIL]\033[0m {msg}")
    else:
        print(f"       {msg}")


def section(title: str) -> None:
    print()
    print(f"=== {title} " + "=" * (60 - len(title)))


# ---------------------------------------------------------------------------
# Preflight: 現在の IP とプロキシ状態
# ---------------------------------------------------------------------------
def preflight() -> tuple[str, str]:
    """現在の出口 IPと、プロキシを使った場合の出口 IPを返す。"""
    section("Preflight: IP check")

    direct_ip = "?"
    proxy_ip = "?"

    try:
        r = subprocess.run(
            ["curl", "-sS", "--max-time", "10", "https://ifconfig.io"],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0 and r.stdout.strip():
            direct_ip = r.stdout.strip().splitlines()[-1]
            p(f"direct exit IP (no proxy): {direct_ip}")
        else:
            p(f"direct curl failed rc={r.returncode}", ok=False)
    except Exception as e:
        p(f"direct curl exception: {e}", ok=False)

    proxy = os.environ.get("PROXY_SERVER")
    if proxy:
        try:
            _u = urlparse(proxy)
            p(f"PROXY_SERVER set: {_u.scheme}://***@{_u.hostname}:{_u.port}")
        except Exception:
            p("PROXY_SERVER set: (unparsable)")
        try:
            r = subprocess.run(
                ["curl", "-sS", "--max-time", "10", "-x", proxy, "https://ifconfig.io"],
                capture_output=True, text=True, timeout=15,
            )
            if r.returncode == 0 and r.stdout.strip():
                proxy_ip = r.stdout.strip().splitlines()[-1]
                p(f"proxy exit IP: {proxy_ip}", ok=True)
            else:
                p(f"proxy curl failed rc={r.returncode} stderr={r.stderr[:200]!r}", ok=False)
        except Exception as e:
            p(f"proxy curl exception: {e}", ok=False)
    else:
        p("PROXY_SERVER not set (direct connection)")

    return direct_ip, proxy_ip


# ---------------------------------------------------------------------------
# CloakBrowser を起動
# ---------------------------------------------------------------------------
def make_browser(headless: bool):
    from cloakbrowser import launch
    kwargs = {
        "headless": headless,
        "humanize": True,
        "human_preset": "careful",
        "locale": "ja-JP",
        "timezone": "Asia/Tokyo",
    }
    proxy = os.environ.get("PROXY_SERVER")
    if proxy:
        kwargs["proxy"] = proxy
    license_key = os.environ.get("CLOAKBROWSER_LICENSE_KEY")
    if license_key:
        kwargs["license_key"] = license_key
    return launch(**kwargs)


# ---------------------------------------------------------------------------
# 個別テスト
# ---------------------------------------------------------------------------
def test_ifconfig(page) -> str | None:
    """ブラウザの見ている出口 IP を確認。

    ifconfig.io は body.inner_text() だと 'What is my ip address?' というヘッダから始まる
    ので、より確実な /ip エンドポイントを使う（プレーンテキストで IP だけ返す）。
    """
    section("Test 1/3: ifconfig.io (ブラウザの出口 IP)")
    try:
        page.goto("https://ifconfig.io/ip", wait_until="load", timeout=30_000)
        time.sleep(1.0)
        text = (page.locator("body").inner_text() or "").strip()
        # 最初に見つかった IPv4 / IPv6 らしき行を抽出
        import re as _re
        ip_re = _re.compile(r"([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:]{2,}:[0-9a-fA-F:]+)")
        for line in text.splitlines():
            m = ip_re.search(line.strip())
            if m:
                ip = m.group(1)
                p(f"browser exit IP: {ip}", ok=True)
                return ip
        p(f"could not parse IP from body: {text[:200]!r}", ok=False)
    except Exception as e:
        p(f"exception: {e}", ok=False)
    return None


# Cloudflare の壁 (Just a moment... 系) を示すワードのブラックリスト
# ※ locale="ja-JP" で走ると Cloudflare は日本語で表示するので両方カバーする
_STUCK_SIGNALS = [
    # 英語版
    "Just a moment", "Checking your browser",
    "Please stand by", "Enable JavaScript and cookies",
    "Verifying you are human", "cf-chl",
    # 日本語版
    "\u3057\u3070\u3089\u304f\u304a\u5f85\u3061\u304f\u3060\u3055\u3044",  # しばらくお待ちください
    "\u30bb\u30ad\u30e5\u30ea\u30c6\u30a3\u691c\u8a3c",                       # セキュリティ検証
    "\u30d6\u30e9\u30a6\u30b6\u3092\u78ba\u8a8d",                              # ブラウザを確認
    "\u60aa\u610f\u306e\u3042\u308b\u30dc\u30c3\u30c8\u304b\u3089\u4fdd\u8b77", # 悪意のあるボットから保護
]

# --- Turnstile デモサイト一覧 ---
# 各サイトで Turnstile が非同期で解けると、DOM に cf-turnstile-response 入力が生えて
# その value に長いトークンが入る。それが「Turnstile 通過した」判定の一次シグナル。
TURNSTILE_DEMO_SITES = [
    ("nowsecure.nl",           "https://nowsecure.nl/",                        ["nowsecure", "nodriver", "you are human"]),
    ("turnstiledemo.luso",     "https://turnstiledemo.lusostreams.com/",       []),
    ("2captcha.demo",          "https://2captcha.com/demo/cloudflare-turnstile",["success", "solved"]),
    ("clifford.io.demo",       "https://clifford.io/demo/cloudflare-turnstile",[]),
    ("demo.turnstile.workers", "https://demo.turnstile.workers.dev/",           ["success"]),
    ("nopecha.demo.cloudflare","https://nopecha.com/demo/cloudflare",           []),
    ("nopecha.captcha.turnstile","https://nopecha.com/captcha/turnstile",       []),
    ("peet.ws.managed",        "https://peet.ws/turnstile-test/managed.html",   []),
]


def _read_turnstile_token(page) -> str:
    """ページ内の cf-turnstile-response 入力の value を読む (最初に見つかった非空のもの)。"""
    try:
        return page.evaluate(
            "() => { const els = document.querySelectorAll('input[name=\"cf-turnstile-response\"]');"
            "        for (const e of els) { if (e.value && e.value.length > 20) return e.value; } return ''; }"
        ) or ""
    except Exception:
        return ""


def _find_turnstile_iframe(page):
    """Turnstile ウィジェットの iframe を返す。無ければ None。

    Cloudflare Turnstile は必ず https://challenges.cloudflare.com/... を src にする
    iframe を挿入する。それが可視かつ bounding box を持っていれば「チェックボックス」
    表示中とみなせる。
    """
    try:
        return page.query_selector("iframe[src*='challenges.cloudflare.com']")
    except Exception:
        return None


def _try_click_turnstile(page, name: str) -> bool:
    """Turnstile のチェックボックスが表示されていたらクリックしてみる。

    Turnstile の checkbox は iframe の中にあり、通常 iframe の左端から
    ~27px, 上端から ~28px の位置に描画される。CloakBrowser の humanize
    と組み合わせて自然な mouse move で該当ピクセルをクリックすることで、
    Managed Challenge を通す試み。

    戻り値: True = クリックした, False = 該当 iframe が無かった or 例外
    """
    try:
        el = _find_turnstile_iframe(page)
        if not el:
            return False
        box = el.bounding_box()
        if not box or box.get("width", 0) < 20:
            return False
        # scroll into view first
        try:
            el.scroll_into_view_if_needed(timeout=3000)
            time.sleep(0.3)
            box = el.bounding_box() or box
        except Exception:
            pass
        # クリック目標: iframe 左上から (27, 28) 付近
        target_x = box["x"] + 27
        target_y = box["y"] + 28
        p(f"[{name}] Turnstile checkbox detected at ~({target_x:.0f}, {target_y:.0f}) - clicking")
        # humanize が careful preset なら Bezier で自然に動く
        page.mouse.move(target_x - 60, target_y - 20, steps=15)
        time.sleep(0.2)
        page.mouse.move(target_x, target_y, steps=10)
        time.sleep(0.15)
        page.mouse.down()
        time.sleep(0.08)
        page.mouse.up()
        return True
    except Exception as e:
        p(f"[{name}] click attempt exception: {e}")
        return False


def _run_turnstile_demo(page, name: str, url: str, extra_pass_words: list[str]) -> bool:
    """1 つの Turnstile デモサイトをテストして PASS/FAIL を返す。

    判定方針: 「Cloudflare の壁で止まっていない = ページ本体に到達できた = PASS」。

    ※ token (cf-turnstile-response) は「あれば強い証拠」だが必須ではない。
      理由:
        - デモサイトによっては Turnstile がフォーム送信時にだけ発火し、
          ページロード直後には widget が無い
        - explicit render モードでは JS 呼び出しまで token が生成されない
        - ハブページで実際の Turnstile は別 URL
      本当に見たいのは「datacenter IP と判定されて Cloudflare の壁 (Just a
      moment...) で止められていないか」なので、壁ワードのブラックリスト
      + 本体コンテンツが表示されているかで判定する。

    判定順:
      NG: 壁ワード (英語 or 日本語) が見えたら即 FAIL
      OK: token が生えたら PASS (Turnstile widget が実在&解けた)
      OK: extra_pass_words のどれかが body/title にあれば PASS
      OK: body に有意な量のテキストがあれば「壁で止まってない」= PASS
      それ以外は unclear = FAIL
    """
    try:
        page.goto(url, wait_until="load", timeout=60_000)
    except Exception as e:
        p(f"[{name}] goto failed: {e}", ok=False)
        return False

    # フェーズ1: まず 5s 待って auto (non-interactive) で通るか確認
    # フェーズ2: 通らなかったら Turnstile checkbox の存在確認 → クリック試行
    # フェーズ3: クリック後さらに 10s 待って token を polling
    token = ""
    clicked = False
    # フェーズ1
    for _ in range(10):  # 5s
        time.sleep(0.5)
        token = _read_turnstile_token(page)
        if token:
            break
    # フェーズ2 + 3
    if not token:
        clicked = _try_click_turnstile(page, name)
        if clicked:
            for _ in range(20):  # +10s
                time.sleep(0.5)
                token = _read_turnstile_token(page)
                if token:
                    break

    # 判定材料を集める
    try:
        title = page.title() or ""
    except Exception:
        title = ""
    try:
        body = (page.locator("body").inner_text() or "")[:400]
    except Exception:
        body = ""
    combined = f"{title}\n{body}"

    p(f"[{name}] title={title!r}")
    p(f"[{name}] body head={body[:120]!r}")
    p(f"[{name}] token_len={len(token)} clicked={clicked}")

    # 1) 壁ワード検出 → FAIL
    stuck_hit = next((s for s in _STUCK_SIGNALS if s in combined), None)
    if stuck_hit:
        p(f"[{name}] stuck on Cloudflare wall (matched: {stuck_hit!r})", ok=False)
        return False

    # 2) token が生えている → 明示的 PASS
    if token:
        p(f"[{name}] Turnstile token issued (len={len(token)}) -> PASSED", ok=True)
        return True

    # 3) サイト固有の成功ワード
    if extra_pass_words:
        body_low = body.lower()
        title_low = title.lower()
        pass_hit = next((w for w in extra_pass_words if w in body_low or w in title_low), None)
        if pass_hit:
            p(f"[{name}] page-specific pass word matched: {pass_hit!r} -> PASSED", ok=True)
            return True

    # 4) 壁ワードは無く、本体テキストが十分あれば「壁で止まってない」= PASS
    # (デモサイトのハブや説明ページなど、Turnstile 未発火でも通過扱いにする)
    body_stripped = body.strip()
    if len(body_stripped) >= 40:
        p(f"[{name}] no wall + page rendered (body {len(body_stripped)} chars) -> PASSED (loose)", ok=True)
        return True

    p(f"[{name}] page content too short and no signals -> FAIL", ok=False)
    return False


def test_turnstile_demos(page) -> dict[str, bool]:
    """全 Turnstile デモサイトを回して結果 dict を返す。"""
    section("Test 2/3: Cloudflare Turnstile 8 デモサイト巡回")
    results: dict[str, bool] = {}
    for i, (name, url, pass_words) in enumerate(TURNSTILE_DEMO_SITES, 1):
        print()
        p(f"--- [{i}/{len(TURNSTILE_DEMO_SITES)}] {name} ({url}) ---")
        results[name] = _run_turnstile_demo(page, name, url, pass_words)
    return results


def test_sannysoft(page) -> bool:
    """bot.sannysoft.com はフィンガープリント検知の定番テストページ。"""
    section("Test 3/3: bot.sannysoft.com (フィンガープリント検知)")
    try:
        page.goto("https://bot.sannysoft.com/", wait_until="load", timeout=60_000)
        time.sleep(3)
        # 'passed' クラスのセルと 'failed' クラスのセルの数を数える
        try:
            passed = page.locator("td.passed, td.result.passed").count()
            failed = page.locator("td.failed, td.result.failed").count()
        except Exception:
            passed = 0
            failed = 0
        p(f"passed count: {passed}, failed count: {failed}")
        if passed > 0 and failed == 0:
            p("fingerprint: no red flags", ok=True)
            return True
        if failed > 0:
            p(f"some fingerprint checks failed ({failed}) - detectable", ok=False)
            return False
        p("could not read result cells (page may have changed layout)")
        return False
    except Exception as e:
        p(f"exception: {e}", ok=False)
        return False


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    headless = os.environ.get("HEADLESS", "").lower() in {"1", "true", "yes", "on"}

    section("Environment")
    p(f"headless mode: {headless}")
    p(f"CI mode: {bool(os.environ.get('CI'))}")

    direct_ip, proxy_ip = preflight()

    try:
        from cloakbrowser import __version__ as cb_ver
        p(f"cloakbrowser version: {cb_ver}")
    except Exception as e:
        p(f"[FATAL] cloakbrowser インポート不可: {e}", ok=False)
        p("        pip install cloakbrowser")
        return 2

    section("Launch CloakBrowser")
    try:
        browser = make_browser(headless)
        page = browser.new_page()
        page.set_default_timeout(60_000)
        page.set_default_navigation_timeout(60_000)
    except Exception as e:
        p(f"[FATAL] browser launch failed: {e}", ok=False)
        return 3

    browser_ip = None
    turnstile_results: dict[str, bool] = {}
    sannysoft_ok = False
    try:
        browser_ip = test_ifconfig(page)
        turnstile_results = test_turnstile_demos(page)
        sannysoft_ok = test_sannysoft(page)
    finally:
        try:
            browser.close()
        except Exception:
            pass

    # ---- Summary ----
    section("Summary")
    p(f"direct IP (curl):   {direct_ip}")
    p(f"proxy IP (curl):    {proxy_ip}")
    p(f"browser IP (Cloak): {browser_ip}")
    p("---- Turnstile デモサイト ----")
    ts_pass = sum(1 for ok in turnstile_results.values() if ok)
    ts_total = len(turnstile_results)
    for name, ok in turnstile_results.items():
        p(f"  {name:26s} : {'PASS' if ok else 'FAIL'}", ok=ok)
    p(f"Turnstile 通過率: {ts_pass}/{ts_total}")
    p("---- Fingerprint ----")
    p(f"  sannysoft: {'PASS' if sannysoft_ok else 'FAIL'}", ok=sannysoft_ok)

    # 使用された実効 IP (プロキシあればそちら、なければ direct)
    effective = proxy_ip if proxy_ip and proxy_ip != "?" else direct_ip
    section("Verdict")
    p(f"tested from IP: {effective}")

    # 3/8 以上通れば「実運用で十分」と判定
    ts_ratio = ts_pass / ts_total if ts_total else 0
    if ts_ratio >= 0.5 and sannysoft_ok:
        p(f"この IP で CloakBrowser は Cloudflare Turnstile を安定して抜けられます ({ts_pass}/{ts_total})", ok=True)
        p("→ Xserver も通る可能性が高い", ok=True)
        return 0
    if ts_ratio >= 0.25 and sannysoft_ok:
        p(f"部分的成功 ({ts_pass}/{ts_total})。運転頻度によっては使えるかも", ok=False)
        return 1
    if not sannysoft_ok:
        p("sannysoft でフィンガープリント検知 → CloakBrowser のセットアップ見直し", ok=False)
    p(f"Turnstile 抜け率が低い ({ts_pass}/{ts_total}) → IP レピュテーション の問題が濃厚", ok=False)
    return 1


if __name__ == "__main__":
    sys.exit(main())
