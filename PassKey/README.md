# Windows Passkey Test

Windows Helloなど、OSのプラットフォーム認証器をWebAuthn APIから呼び出すローカルテストアプリです。

## 重要

パスキーの**秘密鍵そのものを取得・表示することはできません**。秘密鍵はWindows Hello、TPM、セキュリティキーなどの認証器内に保護され、外へ取り出せない設計です。

このアプリで確認できる情報は次のとおりです。

- Credential ID
- 登録時の公開鍵（ブラウザーが `getPublicKey()` に対応する場合）
- 公開鍵アルゴリズム
- Authenticator Data
- Client Data JSON
- 認証時に秘密鍵で生成された署名
- Authenticator AttachmentとTransport情報

## 起動方法

Node.js 18以降をインストールし、PowerShellで次を実行します。

```powershell
cd C:\Users\issei\Documents\Debug\PassKey
npm start
```

EdgeまたはChromeで次を開きます。

```text
http://localhost:3000
```

`localhost` はブラウザーでSecure Contextとして特別扱いされるため、ローカルテストではHTTPでもWebAuthnを利用できます。

## 操作

1. 「パスキーを登録」を押します。
2. Windows HelloのPIN、顔、指紋などで本人確認します。
3. Credential IDと公開鍵情報が画面に表示されます。
4. 「OSパスキーで認証」を押します。
5. 再度本人確認すると、OS内の秘密鍵で生成された署名が表示されます。

## 制限事項

- 登録情報はサーバーのメモリにだけ保存され、サーバー停止時に消去されます。
- WebAuthn APIの呼び出しとレスポンス確認を目的としたデモです。
- 実運用に必要な暗号学的検証は省略しています。
- 実運用ではchallenge、origin、RP ID hash、flags、署名、sign counterをサーバー側で厳密に検証してください。
- `localhost` 以外のホスト名やIPアドレスで使う場合はHTTPS化とRP ID設定の変更が必要です。
