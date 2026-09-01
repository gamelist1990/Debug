# autokick

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Windows版の作成

Node.jsを別途インストールせずに動作するWindows版を作成できます。ビルド時にNode.js、バックエンドのソース、`node_modules`、BedrockXなどのライブラリをTauriリソースへ同梱します。

```bash
bun install
bun run build:windows
```

生成物は `src-tauri/target/release/bundle/` に出力されます。初回だけNode.jsのWindows x64ランタイムをダウンロードし、`%USERPROFILE%\\.autokick-cache` にキャッシュします。Node.jsのバージョンは `AUTOKICK_NODE_VERSION` で変更できます。

開発時は従来どおり `bun run tauri dev` を使用できます。

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
