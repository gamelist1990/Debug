# homeproxy — 家庭用回線を VPS に貸すためのプロキシ

VPS の datacenter IP は Cloudflare の信頼度が低く、Turnstile / Managed
Challenge を通しにくい。家の PC でプロキシを立てて VPS からそこ経由で
出ていくと、Cloudflare からは日本の residential IP として見えるので、
`scrapfly_main.py` / `main.py` （CloakBrowser 版）どちらでも通しやすくなる。

## 構成

```text
[VPS (datacenter IP)]  ---(proxy)--->  [家の PC]  ---(HTTPS)--->  [Xserver / Cloudflare]
                                       ↑
                                       日本の residential IP
```

二通りの繋ぎ方があります。**方式 B (SSH リバーストンネル)** が推奨です。

---

## 方式 B: SSH リバーストンネル（推奨）

ルーター設定を触らなくてよく、家の PC 側のポートも公開しない。
VPS 側は `127.0.0.1:8888` を叩くだけで家の PC に到達する。

### 前提

- 家の PC に **OpenSSH クライアント**（Windows 10 / 11 は標準搭載）
- VPS の SSH ログインができる（あなたはできる、`root@x162-43-53-139`）
- 家の PC で python が動く

### セットアップ

1. **依存インストール**

    ```powershell
    cd homeproxy
    pip install -r requirements.txt
    ```

2. **.env を作成**

    ```powershell
    Copy-Item .env.example .env
    # PROXY_USER / PROXY_PASS を適当に決めて書き換える
    ```

3. **VPS 側で GatewayPorts=no のままにする**（デフォルトでOK）
   → `127.0.0.1:8888` にだけ穴を開ける、安全な運用。

4. **家の PC でローカルプロキシ起動**（別ウィンドウで動かしっぱなし）

    ```powershell
    .\start.ps1
    ```

5. **家の PC で SSH リバーストンネル起動**（別ウィンドウ）

    ```powershell
    .\tunnel.ps1
    ```

    これで家の PC → VPS の SSH セッションが張られ、VPS 側で
    `127.0.0.1:8888` が家のローカルプロキシに転送される。

6. **VPS 側で環境変数をセットして実行**

    ```bash
    # ~/xserver-auto-renew/extend-vps-exp/.env に追記
    echo "PROXY_SERVER=http://<PROXY_USER>:<PROXY_PASS>@127.0.0.1:8888" >> .env

    bash vps_setup.sh --run
    ```

### メリット

- **ルーター設定不要**
- 家の PC の外向きポート開放**ゼロ**
- 認証も SSH の鍵 + プロキシの user/pass の二段構え
- 切断時は自動再接続（tunnel.ps1 が while ループで再接続）

---

## 方式 A: 直接公開（ポート開放が必要）

VPS 側から家のグローバル IP に直接接続する。ルーターでポート開放が必要
なので、方式 B が使えないときの選択肢。

### セットアップ

1. **家の PC でプロキシ起動**

    ```powershell
    .\start.ps1
    ```

2. **ルーターで PORT (デフォ 8888) を家の PC の LAN IP に転送**

3. **家のグローバル IP を確認**

    ```powershell
    (Invoke-WebRequest ifconfig.io -UseBasicParsing).Content.Trim()
    ```

4. **VPS 側**

    ```bash
    echo "PROXY_SERVER=http://<PROXY_USER>:<PROXY_PASS>@<家のグローバルIP>:8888" >> .env
    ```

### 注意

- グローバル IP が動的だと切れる。ダイナミック DNS を併用推奨。
- インターネットに認証プロキシを公開するので、`PROXY_USER` / `PROXY_PASS` は
  必ず**強固なパスワード**を設定すること。
- できれば VPS の IP からしか接続を受け付けないよう Windows Firewall で
  絞ると安全。

---

## ファイル

| ファイル | 用途 |
|---|---|
| `server.py` | 家の PC で動く HTTP+SOCKS5 プロキシ（pproxy ラッパー） |
| `start.ps1` | プロキシ起動用 PowerShell |
| `tunnel.ps1` | SSH リバーストンネル起動用 PowerShell（方式 B 用） |
| `.env.example` | 設定テンプレート |
| `requirements.txt` | pproxy |

---

## 動作確認

家の PC で:

```powershell
# 別ターミナルで起動しておいてから
curl -x http://<PROXY_USER>:<PROXY_PASS>@127.0.0.1:8888 https://ifconfig.io
# → 家のグローバル IP が返れば OK
```

VPS で（方式 B の場合）:

```bash
curl -x http://<PROXY_USER>:<PROXY_PASS>@127.0.0.1:8888 https://ifconfig.io
# → VPS の IP ではなく、家の IP が返れば OK
```

---

## トラブルシュート

### `tunnel.ps1` で「Permission denied」

VPS への SSH 鍵認証が設定できていない。パスワード認証で試すか、
`ssh-copy-id` で公開鍵を VPS に登録。

### `start.ps1` で `pproxy: command not found`

`pip install pproxy` が venv 外で走った可能性。`python -m pproxy` で
動かすように `server.py` を呼ぶ形にしているので、venv を activate してから
`start.ps1` を実行すればOK。

### VPS 側で `Connection refused`

`tunnel.ps1` が落ちている。PowerShell のウィンドウをもう一度確認して
再起動する。
