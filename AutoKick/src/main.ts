import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Account = { id: string; name: string; xuid: string; online: boolean };
type World = { id: string; name: string; owner: string; source: "フレンド" | "フレンドのフレンド"; players: number; max: number; version: string };

const accounts: Account[] = [
  { id: "a1", name: "PixelMori", xuid: "2535423314065012", online: true },
  { id: "a2", name: "BuildLab_02", xuid: "2535423314065013", online: true },
  { id: "a3", name: "redstone_dev", xuid: "2535423314065014", online: false },
];
const worlds: World[] = [
  { id: "w1", name: "Mori Survival", owner: "KumaCraft", source: "フレンド", players: 3, max: 8, version: "1.26.40" },
  { id: "w2", name: "Skyblock Lab", owner: "AoiBuild", source: "フレンドのフレンド", players: 6, max: 10, version: "1.26.40" },
  { id: "w3", name: "Nether Hub", owner: "KumaCraft", source: "フレンド", players: 1, max: 20, version: "1.26.40" },
];
let selectedAccounts = new Set(["a1", "a2"]);
let selectedWorld = "w1";
let running = false;
let logLines = ["セッションの準備ができました。", "BedrockX 接続ブリッジ: 待機中"];
let runTimer: ReturnType<typeof setTimeout> | undefined;

void listen<string>("session-log", (event) => {
  logLines = [...logLines.slice(-5), event.payload];
  render();
});

const app = document.querySelector<HTMLDivElement>("#app")!;
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function render(): void {
  app.innerHTML = `<div class="shell">
    <aside class="sidebar"><div class="brand"><span class="brand-mark">A</span><div><b>AutoKick</b><small>CONTROL CENTER</small></div></div>
      <nav><button class="nav active"><span>⌂</span>ダッシュボード</button><button class="nav"><span>◉</span>アカウント</button><button class="nav"><span>◈</span>セッション履歴</button><button class="nav"><span>⚙</span>設定</button></nav>
      <div class="side-footer"><span class="dot"></span><span>ローカルサービス</span><b>ONLINE</b></div>
    </aside>
    <main><header><div><p class="eyebrow">WORKSPACE / DASHBOARD</p><h1>セッション・コントロール</h1></div><div class="header-actions"><span class="sync">● 最終同期 たった今</span><button class="icon-btn">?</button><button class="avatar">PM</button></div></header>
      <section class="hero"><div><p class="eyebrow">AUTOMATION RUNNER</p><h2>複数アカウントを、ひとつの操作で。</h2><p>フレンドのワールドへ参加し、指定したチャットやコマンドを実行します。</p></div><div class="hero-stat"><strong>${selectedAccounts.size}</strong><span>選択中のアカウント</span></div></section>
      <div class="grid"><section class="panel accounts"><div class="panel-title"><div><p class="eyebrow">01 / ACCOUNTS</p><h3>使用するアカウント</h3></div><button class="text-btn">＋ 追加</button></div><div class="account-list">${accounts.map((a) => `<label class="account ${selectedAccounts.has(a.id) ? "selected" : ""}"><input type="checkbox" data-account="${a.id}" ${selectedAccounts.has(a.id) ? "checked" : ""}/><span class="check">✓</span><span class="account-avatar">${a.name.slice(0, 2).toUpperCase()}</span><span class="account-info"><b>${esc(a.name)}</b><small>XUID ${a.xuid}</small></span><i class="status ${a.online ? "online" : "offline"}"></i></label>`).join("")}</div><button class="manage">アカウント管理を開く <span>→</span></button></section>
      <section class="panel worlds"><div class="panel-title"><div><p class="eyebrow">02 / DESTINATION</p><h3>参加するワールド</h3></div><button class="refresh">↻ 更新</button></div><div class="world-list">${worlds.map((w) => `<button class="world ${selectedWorld === w.id ? "selected" : ""}" data-world="${w.id}"><span class="world-icon">▦</span><span class="world-info"><b>${esc(w.name)}</b><small>${esc(w.owner)}　·　${w.source}</small></span><span class="world-meta"><b>${w.players}/${w.max}</b><small>${w.version}</small></span><span class="chevron">›</span></button>`).join("")}</div><button class="manage">ワールドを再スキャン <span>→</span></button></section>
      <section class="panel automation"><div class="panel-title"><div><p class="eyebrow">03 / AUTOMATION</p><h3>実行するアクション</h3></div><span class="badge">1 TICK 間隔</span></div><div class="form-row"><label>種類<select id="action-type"><option value="chat">チャットメッセージ</option><option value="command">コマンド</option></select></label><label>繰り返し回数<input id="count" type="number" min="1" max="9999" value="5" /></label></div><label class="message-label">内容<textarea id="message" rows="3">Hello from AutoKick!</textarea></label><div class="toggles"><label><input id="friend-requests" type="checkbox" checked/><span></span>滞在中のユーザーへフレンドリクエスト</label><label><input id="auto-exit" type="checkbox" checked/><span></span>完了後に自動退出</label></div></section>
      <section class="panel monitor"><div class="panel-title"><div><p class="eyebrow">LIVE MONITOR</p><h3>実行ログ</h3></div><span class="live"><i></i>${running ? "RUNNING" : "READY"}</span></div><div class="log">${logLines.map((line, i) => `<div><time>${new Date(Date.now() - (logLines.length - i) * 4000).toLocaleTimeString("ja-JP")}</time><span class="log-dot"></span><p>${esc(line)}</p></div>`).join("")}</div></section></div>
      <footer><div><span class="footer-dot"></span><b>${running ? "自動化を実行中" : "実行準備完了"}</b><small>${selectedWorld ? worlds.find((w) => w.id === selectedWorld)?.name : "ワールド未選択"}</small></div><button id="run" class="run" ${running ? "disabled" : ""}>${running ? "実行中…" : "参加して実行する　→"}</button></footer>
    </main></div>`;
  wire();
}

function wire(): void {
  document.querySelectorAll<HTMLInputElement>("[data-account]").forEach((input) => input.onchange = () => { input.checked ? selectedAccounts.add(input.dataset.account!) : selectedAccounts.delete(input.dataset.account!); render(); });
  document.querySelectorAll<HTMLButtonElement>("[data-world]").forEach((button) => button.onclick = () => { selectedWorld = button.dataset.world!; render(); });
  document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => { if (!selectedAccounts.size) return alert("アカウントを1つ以上選択してください。"); running = true; const count = Math.max(1, Number(document.querySelector<HTMLInputElement>("#count")?.value) || 1); const message = document.querySelector<HTMLTextAreaElement>("#message")?.value.trim() || ""; const actionType = document.querySelector<HTMLSelectElement>("#action-type")?.value || "chat"; logLines = ["接続対象を解決しています…", `${selectedAccounts.size} アカウントで ${worlds.find((w) => w.id === selectedWorld)?.name} に参加中`, "バックエンドを起動しています…"]; render(); try { await invoke("start_session", { request: { worldIndex: worlds.findIndex((w) => w.id === selectedWorld) + 1, count, message, actionType } }); } catch (error) { running = false; logLines.push(`起動エラー: ${String(error)}`); render(); } };
}
render();