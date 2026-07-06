"""Xserver 無料VPS 更新スクリプト (Scrapfly 版).

Cloudflare Turnstile / bot 検知は Scrapfly ASP に任せ、数字 CAPTCHA は
同梱の Keras モデル (captcha_solver.py) でローカル解読する。

必要な環境変数 (.env):
  api      = Scrapfly API Key   (小文字キーのまま)
  EMAIL    = Xserver アカウント
  PASSWORD = Xserver パスワード

依存:
  pip install scrapfly-sdk tensorflow
実行:
  python scrapfly_main.py
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import uuid
from pathlib import Path
from urllib.parse import urlencode, urljoin

# ---------------------------------------------------------------------------
# .env ローダ (main.py と同じ実装)
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def load_dotenv(path: str = ".env") -> None:
    env_path = path if os.path.isabs(path) else os.path.join(BASE_DIR, path)
    if not os.path.exists(env_path):
        print(f"[DEBUG] .env not found: {env_path}")
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


load_dotenv()

from scrapfly import ScrapeConfig, ScrapflyClient  # noqa: E402

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")
log = logging.getLogger("scrapfly_xvps").info

LOGIN_URL = "https://secure.xserver.ne.jp/xapanel/login/xvps/"


def get_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"環境変数 {name} が未設定です (.env を確認してください)")
    return v


# ---------------------------------------------------------------------------
# JS シナリオ: ログイン → 契約情報 → 更新する → 継続する → CAPTCHA ページ
# ---------------------------------------------------------------------------
def build_phase1_scenario(email: str, password: str) -> list:
    modal_dismiss = (
        "await new Promise(r => {"
        "  const t0 = Date.now();"
        "  const tick = () => {"
        "    const m = document.querySelector('#campaignModalForFreeUsers.isOpen');"
        "    if (m) { const btn = m.querySelector('button.modal__close'); if (btn) btn.click(); return r(); }"
        "    if (Date.now() - t0 > 5000) return r();"
        "    setTimeout(tick, 200);"
        "  };"
        "  tick();"
        "});"
    )

    wait_turnstile = (
        "await new Promise(r => {"
        "  const t0 = Date.now();"
        "  const tick = () => {"
        "    const el = document.querySelector('input[name=\"cf-turnstile-response\"]');"
        "    if (el && el.value && el.value.length > 20) return r();"
        "    if (Date.now() - t0 > 40000) return r();"
        "    setTimeout(tick, 500);"
        "  };"
        "  tick();"
        "});"
    )

    extract = (
        "(() => {"
        "  const img = document.querySelector('img[src^=\"data:image\"]');"
        "  const cf = document.querySelector('input[name=\"cf-turnstile-response\"]');"
        "  const capInput = document.querySelector('[placeholder=\"\u4e0a\u306e\u753b\u50cf\u306e\u6570\u5b57\u3092\u5165\u529b\"]');"
        "  const form = capInput ? capInput.closest('form') : document.querySelector('form');"
        "  const hidden = {};"
        "  if (form) form.querySelectorAll('input').forEach(i => {"
        "    if (!i.name) return;"
        "    if (i.type === 'submit') return;"
        "    if (capInput && i === capInput) return;"
        "    hidden[i.name] = i.value || '';"
        "  });"
        "  return {"
        "    captcha_src: img ? img.src : null,"
        "    cf_token: cf ? cf.value : null,"
        "    captcha_name: capInput ? (capInput.name || '') : null,"
        "    form_action: form ? form.action : location.href,"
        "    form_method: form ? (form.method || 'POST').toUpperCase() : 'POST',"
        "    hidden,"
        "    href: location.href,"
        "  };"
        "})()"
    )

    return [
        # --- ログインフォーム ---
        {"wait_for_selector": {"selector": "#memberid", "timeout": 15000}},
        {"fill": {"selector": "#memberid", "value": email}},
        {"fill": {"selector": "#user_password", "value": password}},
        {"click": {"selector": "button:has-text('\u30ed\u30b0\u30a4\u30f3\u3059\u308b'), input[value='\u30ed\u30b0\u30a4\u30f3\u3059\u308b']"}},
        {"wait_for_navigation": {"timeout": 20000}},

        # --- キャンペーンモーダルを閉じる ---
        {"execute": {"script": modal_dismiss}},

        # --- 契約情報ページへ ---
        {"click": {"selector": ".contract__menu"}},
        {"wait": 500},
        {"click": {"selector": "a:has-text('\u5951\u7d04\u60c5\u5831')"}},
        {"wait_for_navigation": {"timeout": 20000}},

        # --- 更新する ---
        {"wait_for_selector": {"selector": "text=\u66f4\u65b0\u3059\u308b", "timeout": 15000}},
        {"click": {"selector": "text=\u66f4\u65b0\u3059\u308b"}},
        {"wait_for_navigation": {"timeout": 20000}},

        # --- 引き続き無料VPSの利用を継続する ---
        {"wait_for_selector": {"selector": "text=\u5f15\u304d\u7d9a\u304d\u7121\u6599VPS\u306e\u5229\u7528\u3092\u7d99\u7d9a\u3059\u308b", "timeout": 15000}},
        {"click": {"selector": "text=\u5f15\u304d\u7d9a\u304d\u7121\u6599VPS\u306e\u5229\u7528\u3092\u7d99\u7d9a\u3059\u308b"}},

        # --- CAPTCHA 画像と Turnstile の両方が揃うのを待つ ---
        {"wait_for_selector": {"selector": "img[src^='data:image']", "timeout": 30000}},
        {"wait": 1500},
        {"execute": {"script": wait_turnstile}},
        {"wait": 1500},

        # --- 必要情報を JS で一括抽出 ---
        {"evaluate": {"script": extract}},
    ]


# ---------------------------------------------------------------------------
# js_scenario の最後の evaluate 結果を取り出す
# ---------------------------------------------------------------------------
def extract_evaluate_result(api_response) -> dict | None:
    """Scrapfly のレスポンスから js_scenario の最後の evaluate 結果を抾う."""
    scrape = api_response.scrape_result or {}
    browser = scrape.get("browser_data") or {}

    # Scrapfly のレスポンススキーマはバージョンによって変わるので、
    # いくつかの候補を順に見ていく。
    candidates = [
        browser.get("javascript_evaluation_result"),
        (browser.get("js_scenario") or {}).get("result"),
    ]

    steps = (browser.get("js_scenario") or {}).get("steps") or []
    for step in reversed(steps):
        r = step.get("result") if isinstance(step, dict) else None
        candidates.append(r)
        # 中に value キーで入っている場合もある
        if isinstance(r, dict) and "value" in r:
            candidates.append(r["value"])

    for c in candidates:
        if isinstance(c, dict) and c.get("captcha_src"):
            return c
        # 文字列で返ってくる場合 (JSON)
        if isinstance(c, str):
            try:
                parsed = json.loads(c)
                if isinstance(parsed, dict) and parsed.get("captcha_src"):
                    return parsed
            except Exception:
                pass
    return None


# ---------------------------------------------------------------------------
# メインフロー
# ---------------------------------------------------------------------------
def run() -> int:
    api_key = get_env("api")
    email = get_env("EMAIL")
    password = get_env("PASSWORD")

    session_id = f"xvps-{uuid.uuid4().hex[:10]}"
    log(f"session id: {session_id}")

    client = ScrapflyClient(key=api_key)

    # ---- Phase 1: ログイン → CAPTCHA ページ → 情報抽出 ---------------------
    log("phase1: login and reach captcha page via Scrapfly ASP")
    cfg1 = ScrapeConfig(
        url=LOGIN_URL,
        asp=True,               # Cloudflare / bot 検知のバイパス
        render_js=True,         # ヘッドレスブラウザ
        session=session_id,     # Cookie を保持
        country="jp",
        js_scenario=build_phase1_scenario(email, password),
        rendering_wait=1500,
        debug=True,
    )

    try:
        r1 = client.scrape(cfg1)
    except Exception as e:
        log(f"phase1 exception: {e}")
        return 1

    if not r1.success:
        log(f"phase1 failed: status={r1.status_code}")
        log(f"phase1 body head: {(r1.scrape_result or {}).get('content', '')[:400]}")
        return 1

    info = extract_evaluate_result(r1)

    # evaluate の結果が抾えなかったら HTML からフォールバック抽出
    if not info or not info.get("captcha_src"):
        log("phase1: evaluateの戻り値に captcha_src がありません。HTML から探します")
        html = (r1.scrape_result or {}).get("content", "")
        m_img = re.search(r'<img[^>]+src="(data:image[^"]+)"', html)
        m_cf = re.search(r'name="cf-turnstile-response"[^>]*value="([^"]+)"', html)
        if not m_img:
            log("phase1: CAPTCHA 画像が見つかりません。未契約 / すでに更新済みの可能性があります")
            log(f"HTML head: {html[:400]}")
            return 1
        info = {
            "captcha_src": m_img.group(1),
            "cf_token": m_cf.group(1) if m_cf else None,
            "captcha_name": None,
            "form_action": (r1.scrape_result or {}).get("url") or LOGIN_URL,
            "form_method": "POST",
            "hidden": {},
            "href": (r1.scrape_result or {}).get("url") or LOGIN_URL,
        }

    log(
        f"phase1 ok: captcha_len={len(info['captcha_src'])} "
        f"cf_token_len={len(info.get('cf_token') or '')} "
        f"captcha_name={info.get('captcha_name')!r} "
        f"form_action={info.get('form_action')!r} "
        f"hidden_keys={list((info.get('hidden') or {}).keys())}"
    )

    # ---- Phase 2: CAPTCHA をローカル解読 ----------------------------------
    from captcha_solver import solve as solve_captcha

    code = solve_captcha(info["captcha_src"])
    if not code:
        log("[FAIL] captcha ローカル解読に失敗しました")
        return 1
    log(f"phase2 ok: captcha solved locally -> {code}")

    if not info.get("cf_token"):
        log("[WARN] Turnstile トークンが取れていません。サーバー側でロジックに引っかかる可能性あり")

    # ---- Phase 3: 同じセッションでフォームを直接 POST ------------------
    log("phase3: submit form via direct POST (render_js=False, same session)")

    body_dict: dict = {}
    body_dict.update(info.get("hidden") or {})
    if info.get("captcha_name"):
        body_dict[info["captcha_name"]] = code
    else:
        # フィールド名が抾えなかった場合のフォールバック。
        # ページによって auth_code / captcha / code など名前が異なるので全部入れておく。
        for guess in ("auth_code", "captcha", "captcha_code", "code"):
            body_dict[guess] = code

    if info.get("cf_token"):
        body_dict["cf-turnstile-response"] = info["cf_token"]

    form_action = info.get("form_action") or info.get("href") or LOGIN_URL
    # 相対 URL だったら現在の URL と結合
    if form_action and not form_action.startswith("http"):
        form_action = urljoin(info.get("href") or LOGIN_URL, form_action)

    body = urlencode(body_dict)
    log(f"phase3 target: {form_action}  fields={list(body_dict.keys())}")

    cfg2 = ScrapeConfig(
        url=form_action,
        method="POST",
        body=body,
        headers={
            "content-type": "application/x-www-form-urlencoded",
            "referer": info.get("href") or LOGIN_URL,
            "origin": "https://secure.xserver.ne.jp",
        },
        session=session_id,
        asp=True,
        country="jp",
        debug=True,
    )

    try:
        r2 = client.scrape(cfg2)
    except Exception as e:
        log(f"phase3 exception: {e}")
        return 1

    html = (r2.scrape_result or {}).get("content", "") or ""
    log(f"phase3 status={r2.status_code}")

    if "\u8a8d\u8a3c\u306b\u5931\u6557\u3057\u307e\u3057\u305f" in html:
        log("[FAIL] Cloudflare 認証に失敗しました (Turnstile トークン既日)")
        return 2
    if "\u5165\u529b\u3055\u308c\u305f\u8a8d\u8a3c\u30b3\u30fc\u30c9\u304c\u6b63\u3057\u304f\u3042\u308a\u307e\u305b\u3093" in html:
        log("[FAIL] CAPTCHA コードが不正解でした (ローカルモデルは ~90% 精度)")
        return 3

    # 成功判定: HTTP 200 以上でエラー文言がなければとりあえず OK
    if not r2.success:
        log(f"[FAIL] phase3 非成功 status={r2.status_code}")
        log(f"HTML head: {html[:400]}")
        return 1

    log("[OK] 送信完了")
    print("\u66f4\u65b0\u64cd\u4f5c\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f\u3002Scrapfly ダ\u30c3\u30b7\u30e5\u30dc\u30fc\u30c9\u3067\u30ec\u30b9\u30dd\u30f3\u30b9\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002")
    return 0


if __name__ == "__main__":
    sys.exit(run())
