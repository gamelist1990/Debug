# AutoKick Plugin API

プラグインはユーザーのデータディレクトリに配置します。

```text
Documents/PEXData/AutoKick/plugins/example.js
```

## 基本形式

```js
export default {
  name: "Example",
  version: "1.0.0",
  actions: {
    greet: async ({ api, placeholders }) => {
      await api.chat(`Hello ${placeholders.me}`);
    },
  },
};
```

## API

- `api.log(message)` — AutoKickログへ記録
- `api.chat(message)` — 接続中ワールドへチャット送信
- `api.command(command)` — コマンド送信
- `api.players()` — 現在のプレイヤー一覧
- `api.paths.dataDir` — データディレクトリ
- `api.paths.pluginsDir` — プラグインディレクトリ
- `api.paths.configPath` — 設定ファイル
- `api.paths.tokensPath` — トークンファイル

プラグインは信頼できるJavaScriptだけを配置してください。プラグインはNode.js権限で実行されます。