# Forge Obfuscator

Rustで実装した、実験的なマルチプロジェクト用ビルド・難読化CLIです。

## 対応対象

- Rust / Cargo
- JavaScript
- TypeScript
- React
- Vite

## 動作

- 対象プロジェクトを自動判定します。
- Rustでは`cargo build --release`を実行します。
- Node/React/Viteでは`npm run build`を実行します。
- 元プロジェクトを変更せず、変換済みソースを`obfuscated-dist/source`または`obfuscated-dist/src`へ出力します。
- Vite/React等のビルド済みJavaScriptには`javascript-obfuscator`を適用します。
- RustのリリースバイナリはLTO、シンボル除去、単一codegen unitを使って生成します。

> 難読化は解析を困難にするものであり、秘密情報を安全に隠す仕組みではありません。APIキーやパスワードをソースへ埋め込まないでください。

## ビルド

```powershell
cd C:\Users\issei\Documents\Debug\forge-obfuscator
cargo build --release
```

生成物:

```text
target\release\forge-obfuscator.exe
```

## 使用例

### Vite / React

```powershell
forge-obfuscator.exe C:\path\to\vite-app
```

### TypeScript

```powershell
forge-obfuscator.exe C:\path\to\ts-app --project-type ts
```

### Rust

```powershell
forge-obfuscator.exe C:\path\to\rust-project --project-type rust
```

### 出力先を指定

```powershell
forge-obfuscator.exe C:\path\to\project --output protected-output
```

### ビルドせず変換のみ

```powershell
forge-obfuscator.exe C:\path\to\project --no-build
```

## 出力構造

```text
obfuscated-dist/
  build/       # ビルド成果物
  source/      # JS/TS/React/Viteの変換済みソース
  src/         # Rustの変換済みソース
  package.json # Nodeプロジェクトの場合
  Cargo.toml   # Rustプロジェクトの場合
```

## JavaScript難読化

ビルド成果物のJavaScriptを難読化するとき、CLIは次の形式で`npx`を実行します。

```text
npx --yes javascript-obfuscator <file> --output <temporary-file> ...
```

初回実行時にはnpmがパッケージを取得するため、インターネット接続が必要になる場合があります。Vite自体のminifyに加え、文字列配列化、識別子変換、制御フロー平坦化、self-defendingを適用します。

## 制限事項

- Rustソースは構文を壊さない保守的なコメント除去を行い、公開API名は変更しません。バイナリ側はCargoリリース設定でシンボルを除去します。
- JS/TSの本格的難読化はビルド済みJavaScriptに適用します。TSX/JSXの生ソースへ直接強い難読化を適用すると再ビルド不能になることがあるためです。
- source mapを配布すると元コードの復元が容易になります。公開用ビルドではViteの`sourcemap`を無効にしてください。
