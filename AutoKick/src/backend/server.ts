import { WebSocketServer, type WebSocket } from "ws";
import { type BackendRequest, type BackendEvent } from "./protocol.ts";
import { createXboxRuntime } from "./xboxRuntime.ts";
import { createPluginRuntime } from "./pluginRuntime.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAutoKickConfigPath, getAutoKickFriendRequestsPath } from "./dataPaths.ts";

const port = Number(process.argv[2] ?? 47821);
const server = new WebSocketServer({ host: "127.0.0.1", port });
let running = false;
let autoModeStopRequested = false;
const xbox = createXboxRuntime();
const plugins = createPluginRuntime();
const recentLogs = new Map<string, number>();
server.on("listening", () => console.log(`AUTOKICK_BACKEND_LISTENING:${port}`));
server.on("error", (error) => {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`AUTOKICK_BACKEND_ERROR:ポート ${port} は既に使用中です。既存のバックエンドを使用してください。`);
    return;
  }
  console.error("AUTOKICK_BACKEND_ERROR", error);
});
function broadcast(event: BackendEvent): void {
  const payload = JSON.stringify(event);
  for (const client of server.clients)
    if (client.readyState === client.OPEN) client.send(payload);
}
function log(
  message: string,
  level: "info" | "success" | "warning" | "error" = "info",
): void {
  const key = `${level}:${message}`;
  const now = Date.now();
  const previous = recentLogs.get(key);
  if (previous && now - previous < 1000) return;
  recentLogs.set(key, now);
  console.log(`[${level.toUpperCase()}] ${message}`);
  broadcast({
    type: "session-log",
    timestamp: new Date().toISOString(),
    level,
    message,
  });
}
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return "不明なバックエンドエラー"; }
}
function broadcastRuntimeEvent(event: { type: "players" | "operator" | "chat" | "command-response"; accountId: string; players?: unknown[]; isOperator?: boolean; source?: string; message?: string }): void {
  if (event.type === "players") broadcast({ type: "players", accountId: event.accountId, players: event.players ?? [] });
  else if (event.type === "operator") broadcast({ type: "operator", accountId: event.accountId, isOperator: event.isOperator ?? false });
  else if (event.type === "chat") broadcast({ type: "chat", accountId: event.accountId, source: event.source ?? "不明", message: event.message ?? "" });
  else broadcast({ type: "command-response", accountId: event.accountId, message: event.message ?? "" });
}
async function handle(
  client: WebSocket,
  request: BackendRequest,
): Promise<void> {
  if (request.type === "list-accounts") {
    try {
      client.send(
        JSON.stringify({
          type: "accounts",
          requestId: request.requestId,
          accounts: await xbox.listAccounts(),
        } satisfies BackendEvent),
      );
    } catch (error) {
      client.send(
        JSON.stringify({
          type: "error",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
        } satisfies BackendEvent),
      );
    }
    return;
  }
  if (request.type === "begin-login") { void xbox.beginLogin((verificationUri, userCode) => client.send(JSON.stringify({ type: "auth-code", requestId: request.requestId, verificationUri, userCode } satisfies BackendEvent))).catch((error) => client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent))); return; }
  if (request.type === "load-config") {
    try {
      const source = await readFile(getAutoKickConfigPath(), "utf8").catch(() => "{}");
      client.send(JSON.stringify({ type: "config", requestId: request.requestId, config: source.trim() ? JSON.parse(source) : {} } satisfies BackendEvent));
    } catch (error) { client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent)); }
    return;
  }
  if (request.type === "save-config") {
    try {
      await mkdir(dirname(getAutoKickConfigPath()), { recursive: true });
      // 部分更新で保存される設定(accountOptions等)が、保存済みサーバー
      // リストを上書き消去しないよう、PEXData/config.jsonの既存項目と統合する。
      const currentSource = await readFile(getAutoKickConfigPath(), "utf8").catch(() => "{}");
      const current = currentSource.trim() ? JSON.parse(currentSource) : {};
      const incoming = request.config && typeof request.config === "object" && !Array.isArray(request.config)
        ? request.config as Record<string, unknown>
        : {};
      const merged = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...incoming };
      await writeFile(getAutoKickConfigPath(), `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent));
    } catch (error) { client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent)); }
    return;
  }
  if (request.type === "remove-account") {
    try { await xbox.removeAccount(request.accountId); client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent)); }
    catch (error) { client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent)); }
    return;
  }
  if (request.type === "list-plugins") { client.send(JSON.stringify({ type: "plugins", requestId: request.requestId, plugins: await plugins.list() } satisfies BackendEvent)); return; }
  if (request.type === "list-worlds") {
    try {
      client.send(
        JSON.stringify({
          type: "worlds",
          requestId: request.requestId,
          worlds: await xbox.listWorlds(request.accountId),
        } satisfies BackendEvent),
      );
    } catch (error) {
      console.error("AUTOKICK_LIST_WORLDS_ERROR", error);
      client.send(
        JSON.stringify({
          type: "error",
          requestId: request.requestId,
          message: errorMessage(error),
        } satisfies BackendEvent),
      );
    }
    return;
  }
  if (request.type === "search-friends") { try { client.send(JSON.stringify({ type: "friend-results", requestId: request.requestId, people: await xbox.searchFriends(request.accountId, request.query) } satisfies BackendEvent)); } catch (error) { client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent)); } return; }
  if (request.type === "add-friend") { try { await xbox.addFriend(request.accountId, request.xuid); client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent)); } catch (error) { client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent)); } return; }
  if (request.type === "list-friend-request-queue") {
    try {
      const source = await readFile(getAutoKickFriendRequestsPath(), "utf8").catch(() => "[]");
      const parsed: unknown = source.trim() ? JSON.parse(source) : [];
      const accounts = await xbox.listAccounts();
      const accountNames = new Map(accounts.map((account) => [account.id, account.gamertag]));
      const grouped = new Map<string, { xuid: string; gamertag: string; sent: unknown[]; pending: unknown[] }>();
      for (const item of Array.isArray(parsed) ? parsed : []) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Record<string, unknown>;
        const accountId = typeof entry.accountId === "string" ? entry.accountId : "";
        if (request.accountId && accountId !== request.accountId) continue;
        const xuid = typeof entry.xuid === "string" ? entry.xuid : "";
        const gamertag = typeof entry.gamertag === "string" ? entry.gamertag : xuid;
        const state = entry.state === "sent" ? "sent" : entry.state === "pending" ? "pending" : undefined;
        if (!xuid || !state) continue;
        const sender = {
          accountId,
          gamertag: accountNames.get(accountId) ?? accountId,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
        };
        const current = grouped.get(xuid) ?? { xuid, gamertag, sent: [], pending: [] };
        current[state].push(sender);
        grouped.set(xuid, current);
      }
      const requests = [...grouped.values()];
      client.send(JSON.stringify({ type: "friend-request-queue", requestId: request.requestId, requests } satisfies BackendEvent));
    } catch (error) {
      client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent));
    }
    return;
  }
  if (request.type === "ping") {
    client.send(JSON.stringify({ type: "pong", requestId: request.requestId }));
    return;
  }
  if (request.type === "live-send") { try { await xbox.sendLive(request.accountId, request.message, request.kind); client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent)); } catch (error) { client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent)); } return; }
  if (request.type === "live-start") { try { await xbox.startSession(request.accountIds, request.worldId, { live: true }, log, (event) => broadcastRuntimeEvent(event), plugins); client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent)); } catch (error) { client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) } satisfies BackendEvent)); } return; }
  if (request.type === "live-stop") { await xbox.stopLive(request.accountId); client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent)); return; }
  if (request.type === "start-external-session") {
    if (running) {
      client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: "セッションは既に実行中です。" } satisfies BackendEvent));
      return;
    }
    running = true;
    broadcast({ type: "session-state", state: "running" });
    log(`${request.accountIds.length}アカウントで外部サーバー ${request.host}:${request.port} への接続を開始しました。`);
    void xbox.startExternalSession(request.accountIds, request.host, request.port, request.options, log, (event) => broadcastRuntimeEvent(event), plugins)
      .then(() => { running = false; broadcast({ type: "session-state", state: "stopped" }); })
      .catch((error: unknown) => { running = false; broadcast({ type: "session-state", state: "error", message: error instanceof Error ? error.message : String(error) }); });
    client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent));
    return;
  }
  if (request.type === "start-auto-session") {
    if (running) {
      client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: "セッションは既に実行中です。" } satisfies BackendEvent));
      return;
    }
    autoModeStopRequested = false;
    const worlds = request.worlds.filter((world) => /^[A-Za-z0-9 ]+$/.test(world.ownerGamertag.trim()));
    if (!request.accountIds.length) {
      client.send(JSON.stringify({ type: "error", requestId: request.requestId, message: "自動モードを開始するアカウントがありません。" } satisfies BackendEvent));
      return;
    }
    running = true;
    broadcast({ type: "session-state", state: "running" });
    log(`自動モードを開始しました。対象ワールド=${worlds.length}、アカウント=${request.accountIds.length}`);
    void (async () => {
      let availableWorlds = [...worlds];
      // UI側の一覧は更新途中だと空、または古いアカウントの
      // availableAccountIds だけを持つことがある。開始時に各アカウントの
      // Session Directoryを再取得して、実際に参加可能なワールドを補完する。
      const refreshAvailableWorlds = async () => {
        const discovered = await Promise.all(request.accountIds.map(async (accountId) => {
          const found = await xbox.listWorlds(accountId).catch((error) => {
            log(`${accountId}: 自動モードのワールド再取得に失敗しました（${error instanceof Error ? error.message : String(error)}）。`, "warning");
            return [];
          });
          return found.map((world) => ({
            id: world.id,
            ownerGamertag: world.ownerGamertag,
            accountIds: [accountId],
          }));
        }));
        const merged = new Map(availableWorlds.map((world) => [world.id, world]));
        for (const world of discovered.flat()) {
          const current = merged.get(world.id);
          merged.set(world.id, {
            ...world,
            ...current,
            accountIds: [...new Set([...(current?.accountIds ?? []), ...(world.accountIds ?? [])])],
          });
        }
        availableWorlds = [...merged.values()].filter((world) => /^[A-Za-z0-9 ]+$/.test(world.ownerGamertag.trim()));
      };
      await refreshAvailableWorlds();
      while (!availableWorlds.length && !autoModeStopRequested) {
        log("自動モード: 対象ワールドが見つかるまで待機します。", "warning");
        await refreshAvailableWorlds();
        if (!availableWorlds.length) await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      const processAccount = async (accountId: string, workerIndex: number) => {
        const accountWorlds = availableWorlds.filter((world) => !world.accountIds?.length || world.accountIds.includes(accountId));
        if (!accountWorlds.length) {
          log(`${accountId}: 参加可能なワールドがありません。`, "warning");
          return;
        }
        // 対象を使い切ったら先頭へ戻り、停止要求が来るまで巡回する。
        // アカウントごとに独立したカーソルを持つため、複数アカウントは
        // それぞれ別ワールドを並列に処理できる。
        let worldIndex = workerIndex % accountWorlds.length;
        const failedWorlds = new Set<string>();
        while (!autoModeStopRequested) {
          // 失敗したワールドを同じ巡回で即座に再試行しない。
          // これまでは対象が1件だけの場合、30秒タイムアウト等の直後に
          // 同じワールドへ戻り続け、他の処理へ進めない状態になっていた。
          let next = accountWorlds[worldIndex % accountWorlds.length];
          if (next && failedWorlds.has(next.id)) {
            const alternative = accountWorlds.find((world) => !failedWorlds.has(world.id));
            if (alternative) next = alternative;
            else {
              log(`${accountId}: 対象ワールドを一巡しました。失敗したワールドを再確認するまで待機します。`, "warning");
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              failedWorlds.clear();
              continue;
            }
          }
          worldIndex += 1;
          if (!next) continue;
          log(`${accountId}: 自動モードで ${next.ownerGamertag} のワールドへ接続します。`);
          try {
            await xbox.startSession([accountId], next.id, request.options, log, (event) => broadcastRuntimeEvent(event), plugins);
            log(`${accountId}: ${next.ownerGamertag} のワールドで処理が完了しました。`, "success");
          } catch (error) {
            failedWorlds.add(next.id);
            log(`${accountId}: ${next.ownerGamertag} をスキップします（${error instanceof Error ? error.message : String(error)}）。`, "warning");
          }
        }
      };
      await Promise.all(request.accountIds.map((accountId, index) => processAccount(accountId, index)));
    })().then(() => {
      running = false;
      broadcast({ type: "session-state", state: "stopped" });
    }).catch((error: unknown) => {
      running = false;
      broadcast({ type: "session-state", state: "error", message: error instanceof Error ? error.message : String(error) });
    });
    client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent));
    return;
  }
  if (request.type === "start-session") {
    if (running) {
      client.send(
        JSON.stringify({
          type: "error",
          requestId: request.requestId,
          message: "セッションは既に実行中です。",
        }),
      );
      return;
    }
    running = true;
    broadcast({ type: "session-state", state: "running" });
    const rawAssignments = request.assignments?.length
      ? request.assignments.filter((assignment) => assignment.worldId && assignment.accountIds.length)
      : [{ worldId: request.worldId, accountIds: request.joinMode === "one-account-per-world" ? request.accountIds.slice(0, 1) : request.accountIds }];
    const assignments = request.joinMode === "one-account-per-world"
      ? (() => {
          // UIから古い割当や重複した割当が届いても、バックエンドを最終防衛線にする。
          // 分散参加では「1ワールド1アカウント」「1アカウント1ワールド」を必ず守る。
          const usedWorlds = new Set<string>();
          const usedAccounts = new Set<string>();
          return rawAssignments.flatMap((assignment) => {
            if (usedWorlds.has(assignment.worldId)) return [];
            const accountId = assignment.accountIds.find((id) => !usedAccounts.has(id));
            if (!accountId) return [];
            usedWorlds.add(assignment.worldId);
            usedAccounts.add(accountId);
            return [{ worldId: assignment.worldId, accountIds: [accountId] }];
          });
        })()
      : rawAssignments.map((assignment) => ({
          worldId: assignment.worldId,
          accountIds: [...new Set(assignment.accountIds)],
        }));
    if (!assignments.length) {
      running = false;
      broadcast({ type: "session-state", state: "error", message: "参加可能なワールドとアカウントの組み合わせがありません。" });
      return;
    }
    if (request.joinMode === "one-account-per-world") {
      log(`分散参加割当: ${assignments.map((assignment) => `${assignment.worldId} ← ${assignment.accountIds[0]}`).join(" / ")}`, "info");
    }
    log(`${request.accountIds.length}アカウントの接続を開始しました。参加方式=${request.joinMode === "one-account-per-world" ? "ワールドごとに1アカウント" : "選択アカウント全員"}`);
    void (async () => {
      // 分散参加では各アカウントのmembers.me更新とnonce反映を完了させてから
      // 次のアカウントを開始する。並列開始するとSession Directoryの応答が
      // 入れ替わり、別アカウントのnonceが見えなくなることがある。
      for (const assignment of assignments) {
        await xbox.startSession(assignment.accountIds, assignment.worldId, request.options, log, (event) => broadcastRuntimeEvent(event), plugins);
      }
    })()
      .then(() => {
        running = false;
        broadcast({ type: "session-state", state: "stopped" });
      })
      .catch((error: unknown) => {
        running = false;
        broadcast({
          type: "session-state",
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        log(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      });
    return;
  }
  if (request.type === "stop-session") {
    autoModeStopRequested = true;
    running = false;
    broadcast({ type: "session-state", state: "stopped" });
    log("セッションを停止しました。", "warning");
    await xbox.stopAll();
    client.send(JSON.stringify({ type: "pong", requestId: request.requestId } satisfies BackendEvent));
  }
}
server.on("connection", (client) => {
  client.send(
    JSON.stringify({ type: "ready", version: "0.1.0" } satisfies BackendEvent),
  );
  client.on("message", (data) => {
    try {
      void handle(client, JSON.parse(data.toString()) as BackendRequest);
    } catch {
      client.send(
        JSON.stringify({
          type: "error",
          message: "バックエンド要求の形式が不正です。",
        } satisfies BackendEvent),
      );
    }
  });
});
console.log(`AUTOKICK_BACKEND_READY:${port}`);
process.on("unhandledRejection", (reason) => {
  console.error("AUTOKICK_BACKEND_ERROR", reason);
});
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`AUTOKICK_BACKEND_SHUTDOWN:${signal}`);
  await xbox.stopAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("NetherNet CONNECTRESPONSE待機がタイムアウト") || message.includes("NetherNet CONNECTERROR")) {
    // NetherNetの接続失敗はアカウント単位で処理し、バックエンド全体は終了させない。
    console.error("AUTOKICK_BACKEND_CONNECTION_ERROR", message);
    return;
  }
  console.error("AUTOKICK_BACKEND_FATAL", error);
  void shutdown("uncaughtException");
});
