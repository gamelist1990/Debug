import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";
import { createWriteStream } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const staging = join(root, ".tauri-bundle");
const runtimeDir = join(staging, "node-runtime");
const backendDir = join(staging, "backend");
const nodeVersion = process.env.AUTOKICK_NODE_VERSION ?? "22.14.0";
const archiveName = `node-v${nodeVersion}-win-x64.zip`;
const cacheDir = join(homedir(), ".autokick-cache");
const archive = join(cacheDir, archiveName);
const extracted = join(cacheDir, `node-v${nodeVersion}-win-x64`);

async function download(url, destination) {
  await mkdir(join(destination, ".."), { recursive: true });
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await new Promise((resolvePromise, reject) => {
        const file = createWriteStream(destination);
        const fetchFile = (target) => get(target, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            fetchFile(new URL(response.headers.location, target));
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Node.jsのダウンロードに失敗しました: HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on("finish", () => file.close(resolvePromise));
        }).on("error", reject);
        fetchFile(url);
      });
      return;
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      console.warn(`ダウンロードを再試行します (${attempt}/3)…`);
    }
  }
  throw lastError;
}

// Tauri dev/buildはtauri.conf.jsonのresourcesを先に検査するため、
// staging配下を必ず作り直してから返す。
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
if (!existsSync(archive) || !existsSync(extracted)) {
  if (existsSync(archive) && !existsSync(extracted)) await rm(archive, { force: true });
  console.log(`Node.js ${nodeVersion} をダウンロードしています…`);
  await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archive);
}
if (!existsSync(join(extracted, "node.exe"))) {
  execFileSync("tar", ["-xf", archive, "-C", cacheDir], { stdio: "inherit" });
}
await cp(extracted, runtimeDir, { recursive: true });

// 実行時に必要なソースと、本番実行に必要な依存関係だけをリソースへコピーします。
const runtimeCopyOptions = {
  recursive: true,
  dereference: true,
  filter: (source) => !source.split("\\").includes(".git") && !source.split("/").includes(".git"),
};
await cp(join(root, "src", "backend"), join(backendDir, "src", "backend"), runtimeCopyOptions);
await cp(join(root, "src", "client", "types.ts"), join(backendDir, "src", "client", "types.ts"));
await cp(join(root, "src", "library", "BedrockX"), join(backendDir, "src", "library", "BedrockX"), runtimeCopyOptions);
await mkdir(backendDir, { recursive: true });

// BedrockXを含む本番依存関係だけを一時ランタイムへインストールします。
await writeFile(join(backendDir, "package.json"), JSON.stringify({
  type: "module",
  private: true,
  dependencies: {
    bedrockx: "file:./src/library/BedrockX",
    "bedrock-protocol": "github:PrismarineJS/bedrock-protocol#7bdc8238815114a8a237ad41bbe84b43bee040f1",
    "prismarine-auth": "^3.1.1",
    ws: "^8.18.3",
  },
}, null, 2));
if (process.platform === "win32") {
  execFileSync(process.env.ComSpec ?? "cmd.exe", [
    "/d", "/s", "/c",
    "npm.cmd install --omit=dev --ignore-scripts --no-package-lock",
  ], { cwd: backendDir, stdio: "inherit" });
} else {
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock"], {
    cwd: backendDir,
    stdio: "inherit",
  });
}
console.log(`同梱ランタイムを準備しました: ${staging}`);