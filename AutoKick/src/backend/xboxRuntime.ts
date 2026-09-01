import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountProfile, WorldSession } from "../client/types.ts";
import { getAutoKickConfigPath, getAutoKickFriendRequestsPath, getAutoKickTokensPath } from "./dataPaths.ts";
import type { PluginRuntime } from "./pluginRuntime.ts";

const require = createRequire(import.meta.url);
const BEDROCK_CHAT_MAX_LENGTH = 512;
function truncateBedrockChat(value: string): string {
  // Bedrockのチャット上限はUTF-8バイト数ではなく、プレイヤーが入力できる
  // Unicode文字数として扱う。日本語も512文字まで許可する。
  if (value.length <= BEDROCK_CHAT_MAX_LENGTH) return value;
  let result = value.slice(0, BEDROCK_CHAT_MAX_LENGTH);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
  return result;
}
const BEDROCK_TEXT_PACKET_BYTES = 512;
function splitBedrockChat(value: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    const candidate = chunk + character;
    if (chunk && Buffer.byteLength(candidate, "utf8") > BEDROCK_TEXT_PACKET_BYTES) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}
const { Authflow, Titles } = require("prismarine-auth") as any;
const { Rest } = require("bedrock-protocol/src/xsapi/rest.js") as any;
const bedrockx = require("../library/BedrockX") as {
  createClient(options: Record<string, unknown>): any;
};

export interface XboxRuntime {
  listAccounts(): Promise<AccountProfile[]>;
  removeAccount(accountId: string): Promise<void>;
  beginLogin(onCode: (verificationUri: string, userCode: string) => void): Promise<void>;
  listWorlds(accountId: string): Promise<WorldSession[]>;
  searchFriends(accountId: string, query: string): Promise<unknown[]>;
  addFriend(accountId: string, xuid: string): Promise<void>;
  startSession(
    accountIds: string[],
    worldId: string,
    options: unknown,
    log: (
      message: string,
      level?: "info" | "success" | "warning" | "error",
    ) => void,
    emit?: (event: { type: "players" | "operator" | "chat" | "command-response"; accountId: string; players?: unknown[]; isOperator?: boolean; source?: string; message?: string }) => void,
    plugins?: PluginRuntime,
    retryAttempt?: number,
  ): Promise<void>;
  startExternalSession(
    accountIds: string[],
    host: string,
    port: number,
    options: unknown,
    log: (message: string, level?: "info" | "success" | "warning" | "error") => void,
    emit?: (event: { type: "players" | "operator" | "chat" | "command-response"; accountId: string; players?: unknown[]; isOperator?: boolean; source?: string; message?: string }) => void,
    plugins?: PluginRuntime,
  ): Promise<void>;
  sendLive(accountId: string, message: string, kind: "chat" | "command"): Promise<void>;
  stopLive(accountId: string): Promise<void>;
  stopAll(): Promise<void>;
}

type JsonObject = Record<string, unknown>;
type TokenFactory = ({
  username,
  cacheName,
}: {
  username: string;
  cacheName: string;
}) => { reset(): Promise<void>; getCached(): Promise<JsonObject>; setCached(value: JsonObject): Promise<void>; setCachedPartial(value: JsonObject): Promise<void> };
const tokenPath = getAutoKickTokensPath();
const friendRequestPath = getAutoKickFriendRequestsPath();
type FriendRequestItem = { accountId: string; xuid: string; gamertag: string; state: "pending" | "sent"; updatedAt: string; attempts?: number; lastError?: string };
let friendRequestQueue: FriendRequestItem[] | undefined;
let friendRequestQueueWrite: Promise<void> = Promise.resolve();
let friendRequestWorkerRunning = false;
let friendRequestWorkerTimer: ReturnType<typeof setTimeout> | undefined;
let runtimeAccounts: Map<string, { authflow: any }> = new Map();
let runtimeAccountXuids: Map<string, string> = new Map();
let sessionDirectoryRateLimitUntil = 0;
let sessionDirectoryRequestTail: Promise<void> = Promise.resolve();
const sessionMemberRegistrationTails = new Map<string, Promise<void>>();
async function waitForSessionDirectorySlot(): Promise<void> {
  sessionDirectoryRequestTail = sessionDirectoryRequestTail.then(async () => {
    const waitMs = Math.max(0, sessionDirectoryRateLimitUntil - Date.now());
    if (waitMs) await wait(waitMs);
    await wait(250);
  });
  await sessionDirectoryRequestTail;
}
async function getSessionThrottled(rest: any, sessionName: string): Promise<any> {
  await waitForSessionDirectorySlot();
  try {
    return await rest.getSession(sessionName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("429") || message.includes("currentRequests")) {
      sessionDirectoryRateLimitUntil = Math.max(sessionDirectoryRateLimitUntil, Date.now() + 15_000);
    }
    throw error;
  }
}
async function loadFriendRequestQueue(): Promise<FriendRequestItem[]> {
  if (friendRequestQueue) return friendRequestQueue;
  try {
    const parsed: unknown = JSON.parse(await readFile(friendRequestPath, "utf8"));
    friendRequestQueue = Array.isArray(parsed) ? parsed.filter((item): item is FriendRequestItem => Boolean(item && typeof item === "object" && typeof (item as any).accountId === "string" && typeof (item as any).xuid === "string" && ["pending", "sent"].includes((item as any).state))).map((item) => ({ ...item, attempts: Number.isInteger((item as any).attempts) ? Math.max(0, Number((item as any).attempts)) : 0 })) : [];
  } catch { friendRequestQueue = []; }
  return friendRequestQueue;
}
async function saveFriendRequestQueue(): Promise<void> {
  const snapshot = [...(await loadFriendRequestQueue())];
  friendRequestQueueWrite = friendRequestQueueWrite.then(async () => {
    await mkdir(dirname(friendRequestPath), { recursive: true });
    await writeFile(friendRequestPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  });
  await friendRequestQueueWrite;
}
async function enqueueFriendRequest(accountId: string, xuid: string, gamertag: string): Promise<void> {
  const queue = await loadFriendRequestQueue();
  const existing = queue.find((item) => item.accountId === accountId && item.xuid === xuid);
  if (existing) {
    existing.gamertag = gamertag;
    await saveFriendRequestQueue();
    scheduleFriendRequestWorker();
    return;
  }
  queue.push({ accountId, xuid, gamertag, state: "pending", updatedAt: new Date().toISOString() });
  await saveFriendRequestQueue();
  scheduleFriendRequestWorker();
}

async function enqueueFriendRequestForEnabledAccounts(xuid: string, gamertag: string, skipAccountId?: string): Promise<string[]> {
  const queuedFor: string[] = [];
  for (const accountId of runtimeAccounts.keys()) {
    // 現在接続中のアカウントですでに相互フレンドでも、他のアカウント
    // への申請まで省略してはいけない。呼び出し側からそのアカウント
    // だけを明示的に除外する。
    if (accountId === skipAccountId) continue;
    if (runtimeAccountXuids.get(accountId) === xuid) continue;
    if (!await isBackgroundFriendRequestEnabled(accountId)) continue;
    await enqueueFriendRequest(accountId, xuid, gamertag);
    queuedFor.push(accountId);
  }
  return queuedFor;
}

function scheduleFriendRequestWorker(delay = 0): void {
  if (friendRequestWorkerTimer) return;
  friendRequestWorkerTimer = setTimeout(() => {
    friendRequestWorkerTimer = undefined;
    void processFriendRequestQueue();
  }, delay);
}

function isFriendRequestQueued(accountId: string, xuid: string): boolean {
  return Boolean(friendRequestQueue?.some((item) => item.accountId === accountId && item.xuid === xuid));
}

async function isBackgroundFriendRequestEnabled(accountId: string): Promise<boolean> {
  try {
    const source = await readFile(getAutoKickConfigPath(), "utf8");
    const config = source.trim() ? JSON.parse(source) : {};
    // selectedAccountIdsはワールド参加対象だけを表す。フレンド申請の
    // バックグラウンド処理可否には使用せず、アカウント個別設定だけを見る。
    const options = config?.accountOptions?.[accountId];
    // 旧設定ではこの項目がsendFriendRequestsとして保存されている。
    // どちらの形式でもバックグラウンド送信を継続できるようにする。
    return options?.autoFriendRequestPlayers === true || options?.sendFriendRequests === true;
  } catch {
    return false;
  }
}

async function processFriendRequestQueue(): Promise<void> {
  if (friendRequestWorkerRunning) return;
  friendRequestWorkerRunning = true;
  try {
    const queue = await loadFriendRequestQueue();
    // 既存のfriendrequest.jsonも、各宛先を「設定が有効な全アカウント」へ
    // 展開する。以前は検出したアカウント1件分だけが保存されていた。
    let queueExpanded = false;
    const targets = new Map(queue.map((entry) => [entry.xuid, entry.gamertag]));
    for (const [xuid, gamertag] of targets) {
      for (const accountId of runtimeAccounts.keys()) {
        if (runtimeAccountXuids.get(accountId) === xuid || !await isBackgroundFriendRequestEnabled(accountId)) continue;
        if (queue.some((entry) => entry.accountId === accountId && entry.xuid === xuid)) continue;
        queue.push({ accountId, xuid, gamertag, state: "pending", updatedAt: new Date().toISOString(), attempts: 0 });
        queueExpanded = true;
      }
    }
    if (queueExpanded) await saveFriendRequestQueue();
      // 先頭のアカウントが未ログインでも、その項目でキュー全体を止めない。
      // accountIdごとに独立した待機列として処理する。
      let item: FriendRequestItem | undefined;
      for (const entry of queue) {
        if (entry.state !== "pending" || !runtimeAccounts.has(entry.accountId)) continue;
        // バックグラウンド申請が有効なアカウントだけ送信する。
        // ただしキュー自体は保持し、設定を有効にした時点で再開する。
        if (!await isBackgroundFriendRequestEnabled(entry.accountId)) continue;
        item = entry;
        break;
      }
      if (!item) {
        // 未ログインのアカウントの項目は、次回ログイン後に再開する。
        if (queue.some((entry) => entry.state === "pending")) scheduleFriendRequestWorker(15_000);
        return;
      }
    const account = runtimeAccounts.get(item.accountId);
      if (!account) return;
    try {
      const token = await account.authflow.getXboxToken();
      const response = await fetch(`https://social.xboxlive.com/users/me/people/friends/v2/xuid(${encodeURIComponent(item.xuid)})`, {
        method: "PUT",
        headers: { Authorization: `XBL3.0 x=${token.userHash};${token.XSTSToken}` },
      });
      if (response.ok || response.status === 409) {
        item.state = "sent";
        item.updatedAt = new Date().toISOString();
        item.lastError = undefined;
        await saveFriendRequestQueue();
      } else {
        item.attempts = (item.attempts ?? 0) + 1;
        item.updatedAt = new Date().toISOString();
        item.lastError = `HTTP ${response.status}`;
        await saveFriendRequestQueue();
        scheduleFriendRequestWorker(15_000);
      }
    } catch (error) {
      item.attempts = (item.attempts ?? 0) + 1;
      item.updatedAt = new Date().toISOString();
      item.lastError = error instanceof Error ? error.message : String(error);
      await saveFriendRequestQueue();
      scheduleFriendRequestWorker(15_000);
    }
    if (item.state === "sent") scheduleFriendRequestWorker(5_000);
  } finally {
    friendRequestWorkerRunning = false;
  }
}
let tokenQueue: Promise<void> = Promise.resolve();
async function loadTokenStore(): Promise<Record<string, Record<string, JsonObject>>> {
  if (!existsSync(tokenPath)) return {};
  const source = await readFile(tokenPath, "utf8");
  const parsed: unknown = source.trim() ? JSON.parse(source) : {};
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, Record<string, JsonObject>> : {};
}
function cacheFactory({ username, cacheName }: { username: string; cacheName: string }): ReturnType<TokenFactory> {
  const account = username || "default";
  return {
    async reset() { await updateCache(account, cacheName, () => ({})); },
    async getCached() { await tokenQueue; const store = await loadTokenStore(); return store[account]?.[cacheName] ?? {}; },
    async setCached(value) { await updateCache(account, cacheName, () => value); },
    async setCachedPartial(value) { await updateCache(account, cacheName, (current) => ({ ...current, ...value })); },
  };
}
async function updateCache(account: string, cacheName: string, updater: (current: JsonObject) => JsonObject): Promise<void> {
  tokenQueue = tokenQueue.then(async () => { const store = await loadTokenStore(); store[account] ??= {}; store[account][cacheName] = updater(store[account][cacheName] ?? {}); await writeFile(tokenPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); });
  return tokenQueue;
}
async function removeTokenAccount(account: string): Promise<void> {
  tokenQueue = tokenQueue.then(async () => {
    const store = await loadTokenStore();
    delete store[account];
    await writeFile(tokenPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  });
  return tokenQueue;
}
async function fetchAvatarDataUrl(rest: any, xuid: string): Promise<string | undefined> {
  const urls = [
    `https://avatar-ssl.xboxlive.com/avatar/${encodeURIComponent(xuid)}/avatar-body.png`,
  ];
  for (const url of urls) {
    try { const response = await fetch(url); if (!response.ok) continue; const contentType = response.headers.get("content-type") ?? "image/png"; const data = Buffer.from(await response.arrayBuffer()).toString("base64"); return `data:${contentType};base64,${data}`; } catch { /* 次のURLを試す */ }
  }
  void rest;
  return undefined;
}

async function refreshAuthTokens(
  authflow: any,
  gamertag: string,
  log: (message: string, level?: "info" | "success" | "warning" | "error") => void,
): Promise<any | undefined> {
  try {
    const xboxToken = await authflow.getXboxToken();
    await authflow.getMinecraftBedrockServicesToken({ version: "1.26.40" });
    log(`${gamertag}: 認証Tokenを更新しました。`, "info");
    return xboxToken;
  } catch (error) {
    log(`${gamertag}: 認証Tokenの更新に失敗しました。${error instanceof Error ? ` ${error.message}` : ""}`, "warning");
    return undefined;
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasSessionNonce(session: any, xuid: string): boolean {
  return typeof getSessionNonce(session, xuid) === "string";
}

function extractXuid(person: any): string | undefined {
  const normalizeXuid = (value: unknown): string | undefined => {
    if (typeof value === "string") return /^\d{16}$/.test(value) ? value : undefined;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      const text = value.toString();
      return /^\d{16}$/.test(text) ? text : undefined;
    }
    if (typeof value === "bigint") {
      const text = value.toString();
      return /^\d{16}$/.test(text) ? text : undefined;
    }
    return undefined;
  };
  const direct = normalizeXuid(person);
  if (direct) return direct;
  const candidates = [
    person?.xuid,
    person?.id,
    person?.xboxUserId,
    person?.xboxUserID,
    person?.user?.xuid,
    person?.user?.id,
    person?.person?.xuid,
    person?.person?.id,
    person?.result?.xuid,
    person?.result?.id,
  ];
  for (const candidate of candidates) {
    const xuid = normalizeXuid(candidate);
    if (xuid) return xuid;
  }
  return undefined;
}

function primitiveText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveGamertag(rest: any, xuid: string, fallback = ""): Promise<string> {
  const profile = await rest.getProfile(xuid).catch(() => undefined);
  const profileUser = profile?.profileUsers?.[0] ?? profile;
  const settings = Array.isArray(profileUser?.settings) ? profileUser.settings : [];
  const gamertag = settings.find((item: any) => ["Gamertag", "ModernGamertag", "GameDisplayName"].includes(item?.id))?.value
    ?? profileUser?.gamertag
    ?? profileUser?.modernGamertag
    ?? profileUser?.displayName;
  return typeof gamertag === "string" && gamertag.trim() ? gamertag.trim() : fallback || xuid;
}

function getSessionPropertySources(session: any): Record<string, any>[] {
  const value = session?.result ?? session;
  return [
    value?.properties?.custom,
    value?.properties?.customProperties,
    value?.relatedInfo?.customProperties,
    value?.relatedInfo?.custom,
    value?.customProperties,
    value?.custom,
  ].filter((item): item is Record<string, any> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function getSessionProperties(session: any): Record<string, any> {
  // APIのレスポンス形式は handles/query と個別GETで異なり、
  // SupportedConnections と nonces が別のcustom領域に入る場合がある。
  return Object.assign({}, ...getSessionPropertySources(session));
}

function getSessionNonce(session: any, xuid: string): string | undefined {
  const normalizedXuid = String(xuid);
  const visited = new Set<object>();
  const search = (value: any): string | undefined => {
    if (!value || typeof value !== "object" || visited.has(value)) return undefined;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = search(item);
        if (found) return found;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.toLocaleLowerCase().includes("nonce") && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [candidateXuid, candidateNonce] of Object.entries(child)) {
          if (String(candidateXuid) === normalizedXuid && typeof candidateNonce === "string" && candidateNonce.length > 0) return candidateNonce;
        }
      }
      const found = search(child);
      if (found) return found;
    }
    return undefined;
  };
  return search(session);
}

async function waitForSessionNonce(rest: any, sessionName: string, xuid: string, initial: any): Promise<any> {
  let current = initial;
  let lastError = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasSessionNonce(current, xuid)) return current;
    try {
      const refreshed = await getSessionThrottled(rest, sessionName);
      if (refreshed) current = refreshed;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (lastError.includes("403") || lastError.includes("429")) break;
      // Session Directoryの反映待ちとして再試行する。
    }
    if (hasSessionNonce(current, xuid)) return current;
    await wait(750);
  }
  if (!hasSessionNonce(current, xuid)) {
    const properties = getSessionProperties(current);
    const nonceKeys = properties.nonces && typeof properties.nonces === "object" && !Array.isArray(properties.nonces) ? Object.keys(properties.nonces) : [];
    console.warn(`[Session Directory] nonce未取得 session=${sessionName} xuid=${xuid} lastError=${lastError || "none"} properties=${JSON.stringify({ hasConnections: Array.isArray(properties.SupportedConnections), nonceKeys })}`);
    if (nonceKeys.length && !nonceKeys.includes(String(xuid))) {
      console.warn(`[Session Directory] 要求XUIDのnonceがありません requested=${xuid} available=${nonceKeys.join(",")}`);
    }
  }
  return current;
}

async function resolveSessionWithAccountNonce(rest: any, sessionName: string, xuid: string, initial: any): Promise<any> {
  let current = await waitForSessionNonce(rest, sessionName, xuid, initial);
  if (hasSessionNonce(current, xuid)) return current;

  // 通常のセッションGETでnonceが返らない場合は、参加アカウントを起点にした
  // getSessionsの結果から同じセッションを探す。API環境によってnonceの公開先が
  // handles/queryとusers/{xuid}/sessionsで異なるため、単一経路に依存しない。
  const candidates = await getSessionCandidates(rest, xuid);
  const matching = candidates.find((candidate: any) => candidate?.sessionRef?.name === sessionName);
  if (matching) {
    current = await waitForSessionNonce(rest, sessionName, xuid, matching);
    if (hasSessionNonce(current, xuid)) return current;
  }

  // 個別セッションGETを別経路で最後に再取得する。
  const direct = await rest.getSession(sessionName).catch(() => undefined);
  if (direct) current = await waitForSessionNonce(rest, sessionName, xuid, direct);
  return current;
}

async function registerSessionMemberForNonce(rest: any, sessionName: string, xuid: string): Promise<any | undefined> {
  // 同じセッションへ複数アカウントが同時に members.me を更新すると、
  // Session Directory側の更新が競合して片方のnonce登録が消えることがある。
  // セッション単位で登録→再取得を直列化する。
  const previous = sessionMemberRegistrationTails.get(sessionName) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queuePromise = previous.then(() => current);
  sessionMemberRegistrationTails.set(sessionName, queuePromise);
  await previous;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitForSessionDirectorySlot();
      const updateResponse = await rest.updateSession(sessionName, {
        members: {
          me: {
            constants: { system: { xuid, initialize: true } },
            properties: {
              system: {
                active: true,
                connection: crypto.randomUUID(),
                subscription: { id: crypto.randomUUID(), changeTypes: ["everything"] },
              },
            },
          },
        },
      });
      // 更新直後のレスポンスを必ず同じアカウントで再取得する。
      // PUTのレスポンスにはGETより先に今回登録したアカウントのnonceが
      // 含まれることがあるため、レスポンス自身を最初の候補にする。
      const refreshed = await resolveSessionWithAccountNonce(
        rest,
        sessionName,
        xuid,
        updateResponse ?? await getSessionThrottled(rest, sessionName),
      );
      if (hasSessionNonce(refreshed, xuid)) return refreshed;
      if (attempt < 2) await wait(500);
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("429") || message.includes("currentRequests")) {
      sessionDirectoryRateLimitUntil = Math.max(sessionDirectoryRateLimitUntil, Date.now() + 15_000);
    }
    if (message.includes("Too many members were added to the session")) {
      throw new Error("このワールドはSession Directoryの参加者上限に達しているため、現在このアカウントでは参加できません。別の参加可能アカウントを選ぶか、参加枠が空いてから再試行してください。");
    }
    console.warn(`[Session Directory] nonce登録失敗 session=${sessionName} xuid=${xuid}`, message);
    return undefined;
  } finally {
    release();
    if (sessionMemberRegistrationTails.get(sessionName) === queuePromise) sessionMemberRegistrationTails.delete(sessionName);
  }
}

async function getSessionCandidates(rest: any, xuid: string): Promise<any[]> {
  try {
    const result = await rest.getSessions(xuid);
    if (!Array.isArray(result)) return [];
    return result
      .map((candidate: any) => candidate?.result ?? candidate)
      .filter((candidate: any) => candidate?.sessionRef?.name);
  } catch {
    return [];
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export function createXboxRuntime(): XboxRuntime {
  const accounts = new Map<
    string,
    { authflow: any; rest: any; profile: AccountProfile }
  >();
  runtimeAccounts = accounts;
  // 起動時に残っているpending項目も、バックグラウンドで順番に処理する。
  scheduleFriendRequestWorker(250);
  const sessionCache = new Map<string, any>();
  const externalServers = new Map<string, { host: string; port: number }>();
  const clients = new Map<string, any>();
  const actionWorkers = new Map<string, AbortController>();
  const tokenRefreshTimers = new Map<string, ReturnType<typeof setInterval>>();
  const createAccount = async (authflow: any, token: any, id: string) => {
    const rest = new Rest(authflow);
    const xuid = String(token.userXUID);
    const requestedSettings = "Gamertag,ModernGamertag,UniqueModernGamertag,GameDisplayName";
    // getProfile()は存在するプロフィールオブジェクトを返してもsettingsが空の場合がある。
    // nullish coalescingで最初の空レスポンスを採用せず、名前が実際に含まれるまで
    // 明示的なsettingsエンドポイントを含む各経路を評価する。
    const profileResponses = await Promise.all([
      rest.get(
        `https://profile.xboxlive.com/users/me/profile/settings?settings=${requestedSettings}`,
        { contractVersion: "2" },
      ).catch(() => undefined),
      rest.get(
        `https://profile.xboxlive.com/users/xuid(${encodeURIComponent(xuid)})/profile/settings?settings=${requestedSettings}`,
        { contractVersion: "2" },
      ).catch(() => undefined),
      rest.getProfile("me").catch(() => undefined),
      rest.getProfile(xuid).catch(() => undefined),
    ]);
    const profileUsers = profileResponses
      .map((profile) => profile?.profileUsers?.[0] ?? profile)
      .filter(Boolean);
    const readProfileName = (profileUser: any): string | undefined => {
      const settings = Array.isArray(profileUser?.settings) ? profileUser.settings : [];
      const settingValue = (...ids: string[]) => settings.find(
        (item: any) => ids.some((settingId) => String(item?.id ?? "").toLocaleLowerCase() === settingId.toLocaleLowerCase()),
      )?.value;
      return [
        settingValue("Gamertag"),
        settingValue("ModernGamertag", "UniqueModernGamertag"),
        settingValue("GameDisplayName"),
        profileUser?.gamertag,
        profileUser?.modernGamertag,
        profileUser?.displayName,
      ].find((value) => typeof value === "string" && value.trim().length > 0);
    };
    const gamertag = profileUsers.map(readProfileName).find(Boolean)
      ?? [token?.displayName, token?.gamertag].find((value) => typeof value === "string" && value.trim().length > 0);
    if (!gamertag) {
      console.warn(`[Xbox Profile] ゲーマータグ未取得 xuid=${xuid} profiles=${JSON.stringify(profileUsers.map((profileUser) => ({ settingIds: Array.isArray(profileUser?.settings) ? profileUser.settings.map((item: any) => item?.id).filter(Boolean) : [], keys: profileUser && typeof profileUser === "object" ? Object.keys(profileUser).filter((key) => !key.toLocaleLowerCase().includes("token")) : [] })))}`);
    }
    accounts.set(id, {
      authflow,
      rest,
      profile: { id, gamertag: gamertag ?? `XUID ${token.userXUID}`, xuid: token.userXUID, avatarUrl: await fetchAvatarDataUrl(rest, token.userXUID), status: "online" },
    });
    runtimeAccountXuids.set(id, xuid);
  };

  // 保存済みアカウントは初回API要求を待たず、バックエンド起動時に復元する。
  // forceRefreshを指定して古いXbox Tokenを確実に更新してからプロフィールを取得する。
  const restoreStoredAccounts = async (): Promise<void> => {
    const store = await loadTokenStore();
    for (const username of Object.keys(store)) {
      const authflow = new Authflow(
        username === "default" ? undefined : username,
        cacheFactory,
        {
          authTitle: Titles.MinecraftNintendoSwitch,
          deviceType: "Nintendo",
          flow: "live",
          forceRefresh: true,
        },
        () => {},
      );
      try {
        const token = await authflow.getXboxToken();
        await authflow.getMinecraftBedrockServicesToken({ version: "1.26.40" });
        await createAccount(authflow, token, String(token.userXUID));
      } catch (error) {
        console.warn(
          `[Xbox Auth] 起動時Token更新失敗 account=${username}`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  };
  const accountInitialization = restoreStoredAccounts();

  return {
    async beginLogin(onCode) {
      // usernameを毎回変えないと、Authflowが既存のdefaultキャッシュを再利用し、
      // 2個目のログインが1個目のアカウントを上書きしてしまう。
      const cacheName = `account-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const authflow = new Authflow(cacheName, cacheFactory, { authTitle: Titles.MinecraftNintendoSwitch, deviceType: "Nintendo", flow: "live" }, (data: any) => onCode(data.verification_uri ?? data.verificationUri ?? "https://www.microsoft.com/link", data.user_code ?? data.userCode ?? ""));
      const token = await authflow.getXboxToken();
      const accountId = String(token.userXUID);
      await createAccount(authflow, token, accountId);
    },
    async listAccounts() {
      await accountInitialization;
      return [...accounts.values()].map(({ profile }) => profile);
    },
    async removeAccount(accountId) {
      const account = accounts.get(accountId);
      if (!account) return;
      const store = await loadTokenStore();
      for (const [key, value] of Object.entries(store)) {
        if (key === "default" || key === accountId || JSON.stringify(value).includes(accountId)) await removeTokenAccount(key);
      }
      clients.get(accountId)?.close("account-logout");
      clients.delete(accountId);
      accounts.delete(accountId);
    },
    async startExternalSession(accountIds, host, port, options, log, emit, plugins) {
      const normalizedHost = host.trim();
      if (!normalizedHost || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("外部サーバーのアドレスまたはポートが不正です。");
      }
      const externalId = `external:${normalizedHost}:${port}`;
      externalServers.set(externalId, { host: normalizedHost, port });
      try {
        await this.startSession(accountIds, externalId, options, log, emit, plugins);
      } finally {
        externalServers.delete(externalId);
      }
    },
    async listWorlds(accountId) {
      const account =
        accounts.get(accountId) ??
        (await this.listAccounts(), accounts.get(accountId));
      if (!account?.profile.xuid)
        throw new Error("Xboxアカウントが認証されていません。");
      const ownXuid = account.profile.xuid;
      const ownSessions = await getSessionCandidates(account.rest, ownXuid);

      // Session Directoryの「自分を基点にした検索」だけでは、環境によって
      // フレンドのフレンドのセッションが返らないことがある。テストCLIと同様に
      // 自分のフレンドを基点にした検索も行い、結果をセッション名で統合する。
      let friends: any[] = [];
      try {
        const response = await account.rest.get("https://peoplehub.xboxlive.com/users/me/people/social/decoration/detail", { contractVersion: "3" });
        friends = Array.isArray(response?.people)
          ? response.people
          : Array.isArray(response?.results)
            ? response.results
            : [];
      } catch {
        // 自分のセッション一覧だけでも表示を継続する。
      }
      const friendXuids = new Set(
        friends.map((friend: any) => extractXuid(friend)).filter((xuid): xuid is string => Boolean(xuid)),
      );
      const followingXuids = new Set<string>();
      const followedByXuids = new Set<string>();
      for (const person of friends) {
        const xuid = extractXuid(person);
        if (!xuid) continue;
        if (person.isFollowingCaller === true && person.isFollowedByCaller !== true) followingXuids.add(xuid);
        if (person.isFollowedByCaller === true && person.isFollowingCaller !== true) followedByXuids.add(xuid);
      }
      // Session Directoryは「people + monikerXuid」で指定したXUIDの
      // ソーシャルグラフを基準に検索する。全フレンドを無制限に並列取得せず、
      // APIレート制限を避けながら各フレンドを検索する。
      const socialSearchXuids = new Set([...friendXuids, ...followingXuids, ...followedByXuids]);
      const friendResults = await mapWithConcurrency(
        [...socialSearchXuids],
        4,
        (friendXuid) => getSessionCandidates(account.rest, friendXuid),
      );
      // people APIの取得失敗やページングで一覧が欠けても、
      // Session Directoryの自分基点検索結果は必ず残す。
      const merged = new Map<string, { session: any; source: WorldSession["source"] }>();
      const addSessions = (sessions: unknown, fallbackSource: WorldSession["source"]) => {
        for (const session of Array.isArray(sessions) ? sessions : []) {
          const candidate = session?.result ?? session;
          const name = candidate?.sessionRef?.name;
          if (!name) continue;
          const ownerXuid = extractXuid(
            candidate.ownerXuid ??
            candidate.ownerId ??
            candidate.relatedInfo?.ownerXuid ??
            candidate.properties?.system?.ownerXuid,
          ) ?? "";
          const source: WorldSession["source"] = friendXuids.has(ownerXuid) ? "friend" : fallbackSource;
          const current = merged.get(name);
          merged.set(name, current ?? { session: candidate, source });
        }
      };
      addSessions(ownSessions, "friend-of-friend");
      friendResults.forEach((sessions) => addSessions(sessions, "friend-of-friend"));

      // handles/queryの概要にcustomPropertiesがない場合があるため、
      // 各候補の詳細を取得してから表示情報を確定する。
      const detailed = await mapWithConcurrency([...merged.entries()], 4, async ([name, value]) => {
        try {
          const detail = await account.rest.getSession(name);
          const normalizedDetail = detail?.result ?? detail;
          return [name, { ...value, session: { ...value.session, ...normalizedDetail, sessionRef: normalizedDetail.sessionRef ?? value.session.sessionRef } }] as const;
        } catch (error) {
          // handles/queryで概要情報は読めても、個別GETだけ403になることがある。
          // その場合でもquery側のcustomPropertiesが完全なら、それを使って表示する。
          return [name, value] as const;
        }
      });
      const detailedMerged = new Map(detailed);

      return (await Promise.all([...detailedMerged.values()].map(async ({ session, source }, index): Promise<WorldSession | undefined> => {
        const properties = getSessionProperties(session);
        const sessionId = primitiveText(session.sessionRef?.name) ?? `session-${index}`;
        const worldName = [properties.worldName, properties.levelName, properties.world_name, properties.level_name, properties.name]
          .map(primitiveText).find(Boolean);
        // 一覧表示ではSession Directoryから取得した表示名をそのまま使用する。
        // ワールド更新ごとのXboxプロフィール追加取得は行わない。
        const advertisedHostName = [properties.hostName, properties.ownerGamertag, properties.ownerName, properties.host_name, properties.owner_name]
          .map(primitiveText).find(Boolean);
        const hostName = advertisedHostName ? cleanGamertag(advertisedHostName) : undefined;
        if (!worldName || !hostName) return undefined;
        if (!sessionCache.has(sessionId)) sessionCache.set(sessionId, session);
        return {
          id: sessionId,
          name: worldName,
          ownerGamertag: hostName,
          source,
          players: properties.MemberCount ?? 0,
          maxPlayers: properties.MaxMemberCount,
          version: properties.version,
          availableAccountIds: [accountId],
        };
      }))).filter((world): world is WorldSession => Boolean(world));
    },
    async searchFriends(accountId, query) {
      const account = accounts.get(accountId) ?? (await this.listAccounts(), accounts.get(accountId));
      if (!account) throw new Error("Xboxアカウントが認証されていません。");
      const normalizedQuery = query.trim();
      if (/^\d{16}$/.test(normalizedQuery)) {
        const profile = await account.rest.getProfile(normalizedQuery).catch(() => undefined);
        const profileUser = profile?.profileUsers?.[0] ?? profile;
        const settings = Array.isArray(profileUser?.settings) ? profileUser.settings : [];
        const gamertag = settings.find((item: any) => ["Gamertag", "ModernGamertag", "GameDisplayName"].includes(item?.id))?.value
          ?? profileUser?.gamertag
          ?? profileUser?.modernGamertag
          ?? profileUser?.displayName;
        if (typeof gamertag === "string" && gamertag.trim()) {
          return [{ xuid: normalizedQuery, gamertag: gamertag.trim(), avatarUrl: await fetchAvatarDataUrl(account.rest, normalizedQuery) }];
        }
        return [];
      }
      const response = await account.rest.get(`https://usersearch.xboxlive.com/suggest?q=${encodeURIComponent(normalizedQuery)}`, { contractVersion: "1" });
      const candidates = Array.isArray(response?.results)
        ? response.results.map((item: any) => item?.result ?? item).filter((item: any) => item?.id && (item?.gamertag || item?.modernGamertag || item?.displayName))
        : [];
      if (candidates.length) return await Promise.all(candidates.map(async (item: any) => ({ xuid: String(item.id), gamertag: String(item.gamertag ?? item.modernGamertag ?? item.displayName), avatarUrl: await fetchAvatarDataUrl(account.rest, String(item.id)) })));
      const profileResponse = await account.rest.get(`https://profile.xboxlive.com/users/gt(${encodeURIComponent(normalizedQuery)})/profile/settings?settings=Gamertag,ModernGamertag,GameDisplayName,ModernGamertagSuffix,UniqueModernGamertag`, { contractVersion: "2" }).catch(() => undefined);
      const profile = profileResponse?.profileUsers?.[0] ?? await account.rest.getProfile(normalizedQuery).catch(() => undefined);
      const profileUser = profile?.profileUsers?.[0] ?? profile;
      const settings = Array.isArray(profileUser?.settings) ? profileUser.settings : [];
      const gamertag = settings.find((item: any) => ["Gamertag", "ModernGamertag", "GameDisplayName"].includes(item?.id))?.value ?? profileUser?.gamertag ?? profileUser?.modernGamertag ?? profileUser?.displayName;
      return typeof gamertag === "string" && gamertag.trim() && profileUser?.id
        ? [{ xuid: String(profileUser.id), gamertag: gamertag.trim(), avatarUrl: await fetchAvatarDataUrl(account.rest, String(profileUser.id)) }]
        : [];
    },
    async addFriend(accountId, xuid) {
      const account = accounts.get(accountId) ?? (await this.listAccounts(), accounts.get(accountId));
      if (!account) throw new Error("Xboxアカウントが認証されていません。");
      const token = await account.authflow.getXboxToken();
      const response = await fetch(`https://social.xboxlive.com/users/me/people/friends/v2/xuid(${encodeURIComponent(xuid)})`, { method: "PUT", headers: { Authorization: `XBL3.0 x=${token.userHash};${token.XSTSToken}` } });
      if (!response.ok) throw new Error(`フレンド申請に失敗しました (${response.status})`);
    },
    async startSession(accountIds, worldId, options, log, emit, plugins, retryAttempt = 0) {
      const externalServer = externalServers.get(worldId);
      const session = externalServer ? undefined : sessionCache.get(worldId);
      if (!session && !externalServer)
        throw new Error(
          "ワールド情報が見つかりません。先にワールド一覧を更新してください。",
        );
      const actionMap = (
        options && typeof options === "object" ? options : {}
      ) as Record<string, any>;
      // 同一ワールドではnonce登録・取得・接続を完全に直列化する。
      // 並列実行するとSession Directoryのmembers.meが上書きされ、
      // 先に登録したアカウントのnonceが消えることがある。
      for (const accountId of accountIds) {
        await (async () => {
          const account = accounts.get(accountId);
          if (!account)
            throw new Error(`アカウント ${accountId} が見つかりません。`);
          log(`${account.profile.gamertag}: セッション準備: ワールド ${worldId}`, "info");
          const accountXuid = account.profile.xuid;
          if (!accountXuid) throw new Error(`${account.profile.gamertag} のXUIDが取得できません。`);
          let client: any;
          let properties: any = { hostName: `${externalServer?.host ?? ""}:${externalServer?.port ?? ""}` };
          if (externalServer) {
            client = bedrockx.createClient({
              transport: "DEFAULT",
              host: externalServer.host,
              port: externalServer.port,
              version: "1.26.40",
              protocolVersion: 2168,
              authflow: account.authflow,
              profilesFolder: cacheFactory,
              onMsaCode: (data: any) => console.log("AUTOKICK_MSA_CODE", data),
            });
            log(`${account.profile.gamertag}: 外部サーバー ${externalServer.host}:${externalServer.port} に接続します。`, "info");
          } else {
          const xboxToken = await refreshAuthTokens(account.authflow, account.profile.gamertag, log);
          const tokenXuid = xboxToken?.userXUID ? String(xboxToken.userXUID) : undefined;
          if (tokenXuid && tokenXuid !== String(accountXuid)) {
            log(`${account.profile.gamertag}: 認証TokenのXUID (${tokenXuid}) とアカウント情報 (${accountXuid}) が一致しないため、Token側のXUIDを使用します。`, "warning");
          }
          const sessionAccountXuid = tokenXuid ?? String(accountXuid);
          // nonceは保存・再利用しない。接続開始時のSession Directory応答だけを使う。
          // 一覧取得時の共有セッションには別アカウント用の古いnonceが含まれ得るため、
          // 接続するアカウントで個別GETを行って最新状態から開始する。
          log(`${account.profile.gamertag}: 接続用nonceをSession Directoryから取得します。`, "info");
          let refreshedSession: any;
          try {
            refreshedSession = await getSessionThrottled(account.rest, worldId);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("403 Forbidden") || message.includes("requested session cannot be accessed")) {
              throw new Error(`${account.profile.gamertag}: このワールドへアクセスする権限がありません。Xboxのマルチプレイヤー権限・通信権限、フレンド関係、ワールドの公開範囲、ブロックまたは禁止状態が正しいか確認してください。フレンドのフレンド経由の場合は、このアカウントが参加条件を満たしていない可能性があります。`);
            }
            throw error;
          }
          if (!hasSessionNonce(refreshedSession, sessionAccountXuid)) {
            log(`${account.profile.gamertag}: セッション参加者登録でnonceを要求します。`, "info");
            const registered = await registerSessionMemberForNonce(account.rest, worldId, sessionAccountXuid);
            if (registered) refreshedSession = registered;
          }
                  if (!hasSessionNonce(refreshedSession, sessionAccountXuid)) {
            log(`${account.profile.gamertag}: nonce応答待ちを延長します。`, "warning");
            refreshedSession = await resolveSessionWithAccountNonce(account.rest, worldId, sessionAccountXuid, refreshedSession);
          }
                  if (!hasSessionNonce(refreshedSession, sessionAccountXuid)) {
                    throw new Error(`${account.profile.gamertag}: Session Directoryにこのアカウントのnonceが登録されませんでした。別アカウントのnonceを使用せず、接続を中止しました。時間を置いて再試行してください。`);
                  }
          properties = getSessionProperties(refreshedSession);
          const connection = properties.SupportedConnections?.find(
            (item: any) =>
              Number(item.ConnectionType) === 7 &&
              item.NetherNetId !== undefined &&
              item.PmsgId,
          );
          if (!connection)
            throw new Error(
              "選択したワールドにNetherNet接続情報がありません。",
            );
          const nonce = getSessionNonce(refreshedSession, sessionAccountXuid);
          if (typeof nonce !== "string") throw new Error(`${account.profile.gamertag}: Session Directoryのnonceを取得できないため接続を開始できません。`);
          console.log("[Session Directory][connect-debug]", {
            accountXuid: sessionAccountXuid,
            worldId,
            nonceLength: nonce.length,
            noncePrefix: nonce.slice(0, 6),
            connectionType: connection.ConnectionType,
            netherNetId: String(connection.NetherNetId),
            pmsgId: String(connection.PmsgId),
            version: properties.version,
            protocol: properties.protocol,
            supportedConnectionCount: Array.isArray(properties.SupportedConnections) ? properties.SupportedConnections.length : 0,
          });
          client = bedrockx.createClient({
            transport: "NETHERNET_JSONRPC",
            networkId: BigInt(String(connection.NetherNetId)),
            serverNetworkId: connection.PmsgId,
            version: properties.version ?? "1.26.40",
            protocolVersion: properties.protocol ?? 2168,
            authflow: account.authflow,
            profilesFolder: cacheFactory,
            onMsaCode: (data: any) =>
              console.log("AUTOKICK_MSA_CODE", data),
            skinData: { Nonce: nonce },
          });
          }
          log(`${account.profile.gamertag}: BedrockXクライアントを作成しました。`, "info");
          clients.set(accountId, client);
          const oldTimer = tokenRefreshTimers.get(accountId);
          if (oldTimer) clearInterval(oldTimer);
          tokenRefreshTimers.set(accountId, setInterval(() => {
            void refreshAuthTokens(account.authflow, account.profile.gamertag, log);
          }, 4 * 60 * 1000));
          const knownPlayers = new Map<string, string>();
          const playerNames = new Map<string, string>();
          let autoKickStarted = false;
          let actionReady = false;
          let listDiscoveryReady = false;
          let autoKickDiscoveryFinished = false;
          let resolveAutoKickDiscovery: (() => void) | undefined;
          const autoKickDiscovery = new Promise<void>((resolve) => {
            resolveAutoKickDiscovery = resolve;
          });
          const finishAutoKickDiscovery = () => {
            if (autoKickDiscoveryFinished) return;
            autoKickDiscoveryFinished = true;
            resolveAutoKickDiscovery?.();
            resolveAutoKickDiscovery = undefined;
          };
          let hostAutoKickTimer: ReturnType<typeof setInterval> | undefined;
          let clientOpen = true;
          const delayedDiscoveryTimers: ReturnType<typeof setTimeout>[] = [];
          const expandPlaceholders = (template: string, target?: string) => template
            .replaceAll("{me}", account.profile.gamertag)
            .replaceAll("{random}", target ?? "")
            .replaceAll("{host}", String(properties.hostName ?? ""))
            .replaceAll("{count}", String(knownPlayers.size));
          // UIでは未設定値に既定値を表示しているが、保存済み設定自体には
          // autoKickCommandが存在しない場合がある。表示値と実行値を一致させる。
          const getAutoKickCommand = (action: any): string => {
            const configured = typeof action?.autoKickCommand === "string"
              ? action.autoKickCommand.trim()
              : "";
            return configured || "/tell {random} @a[name=a]";
          };
          let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
          let autoKickCompletion = Promise.resolve();
          let runAutoKickAfterDiscovery: () => void = () => {};
          let finishFriendRequests: () => Promise<void> = async () => {};
          const writeClientPacket = (name: string, payload: Record<string, unknown>): boolean => {
            if (!clientOpen) return false;
            try {
              client.write(name, payload);
              return true;
            } catch (error) {
              // autoExit後に遅れて届いた/list応答などで送信しない。
              const message = error instanceof Error ? error.message : String(error);
              if (clientOpen && !message.toLocaleLowerCase().includes("reliable channel is not open")) {
                log(`${account.profile.gamertag}: ${name}送信をスキップしました (${message})`, "warning");
              }
              return false;
            }
          };
          const clearDelayedDiscovery = () => {
            for (const timer of delayedDiscoveryTimers) clearTimeout(timer);
            delayedDiscoveryTimers.length = 0;
          };
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            const failConnection = (error: unknown) => {
              if (settled) return;
              settled = true;
              finishAutoKickDiscovery();
              clientOpen = false;
              clearDelayedDiscovery();
              if (connectionTimeout) clearTimeout(connectionTimeout);
              clearInterval(friendRequestRetryTimer);
              reject(error instanceof Error ? error : new Error(String(error)));
            };
            const completeConnection = () => {
              if (settled) return false;
              settled = true;
              clearDelayedDiscovery();
              if (connectionTimeout) clearTimeout(connectionTimeout);
              if (spawnFallbackTimer) clearTimeout(spawnFallbackTimer);
              clearInterval(friendRequestRetryTimer);
              resolve();
              return true;
            };
            let spawnFallbackTimer: ReturnType<typeof setTimeout> | undefined;
            const requestedPlayers = new Set<string>();
            let listRequestPending = false;
            let friendRequestProcessing = false;
            let friendRequestDebounceTimer: ReturnType<typeof setTimeout> | undefined;
            let resolveAutoKick: (() => void) | undefined;
            const runAutoKick = () => {
              // player_list/add_player は player_spawn より前にも届くことがある。
              // Reliable channelの初期化完了前にcommand_requestを送ると、
              // 「Reliable channel is not open」になり、処理も失われる。
              if (!actionReady || !listDiscoveryReady) return;
              const action = actionMap[accountId];
              if (action?.autoKickHostOnly) return;
              if (autoKickStarted || !action?.autoKickEnabled) {
                return;
              }
              const autoKickCommand = getAutoKickCommand(action);
              const ownName = cleanGamertag(account.profile.gamertag).toLocaleLowerCase();
              const uniqueTargets = new Map<string, readonly [string, string]>();
              for (const [xuid, rawGamertag] of knownPlayers) {
                const gamertag = cleanGamertag(rawGamertag);
                const key = gamertag.toLocaleLowerCase();
                if (!gamertag || xuid === accountXuid || key === ownName || uniqueTargets.has(key)) continue;
                uniqueTargets.set(key, [xuid, gamertag]);
              }
              const targets = [...uniqueTargets.values()];
              if (!targets.length) {
                log(`${account.profile.gamertag}: AutoKick対象プレイヤーがまだ見つかりません。`, "info");
                return;
              }
              log(`${account.profile.gamertag}: AutoKick対象 ${targets.map(([, name]) => name).join(", ")}`, "info");
              autoKickStarted = true;
              finishAutoKickDiscovery();
              autoKickCompletion = new Promise<void>((finish) => {
                resolveAutoKick = finish;
                void (async () => {
                  // AutoKickは設定回数ではなく、本人以外の人数分を1回ずつ処理する。
                  const count = targets.length;
                  const interval = Math.max(0, Number(action.intervalMs ?? 50));
                  for (let index = 0; index < count; index += 1) {
                    const target = targets[index % targets.length];
                    const randomTarget = target?.[1] ?? "";
                    const command = buildAutoKickCommand(autoKickCommand, {
                      me: account.profile.gamertag,
                      random: randomTarget,
                      player: randomTarget,
                      host: String(properties.hostName ?? ""),
                      count: String(targets.length),
                    });
                    log(`${account.profile.gamertag}: AutoKick実行 ${index + 1}/${count} ${command}`, "info");
                    const sent = writeClientPacket("command_request", {
                      command: command.startsWith("/") ? command : `/${command}`,
                      origin: { type: "player", uuid: crypto.randomUUID(), request_id: "", player_entity_id: 0n },
                      internal: false,
                      version: "latest",
                    });
                    if (!sent) {
                      log(`${account.profile.gamertag}: AutoKick送信を中断しました（接続チャネルが閉じています）。`, "warning");
                      break;
                    }
                    log(`${account.profile.gamertag}: AutoKickコマンドを送信しました。`, "success");
                    // 同一tickに連続送信すると、NetherNetのReliable channelや
                    // サーバー側のコマンド処理が追いつかず、一部だけ無視されることがある。
                    if (index + 1 < count) await new Promise((resolve) => setTimeout(resolve, Math.max(150, interval)));
                  }
                  await new Promise((resolve) => setTimeout(resolve, 500));
                  if (resolveAutoKick === finish) {
                    resolveAutoKick = undefined;
                    finish();
                  }
                })();
              });
            };
            const runHostAutoKick = () => {
              const action = actionMap[accountId];
              if (!action?.autoKickHostOnly || !action.autoKickEnabled || !actionReady || !clientOpen) return;
              const hostName = cleanGamertag(String(
                properties.hostName ??
                properties.ownerGamertag ??
                properties.ownerName ??
                (session as any)?.ownerGamertag ??
                "",
              ));
              if (!hostName) return;
              const command = buildAutoKickCommand(getAutoKickCommand(action), {
                me: account.profile.gamertag,
                random: hostName,
                player: hostName,
                host: hostName,
                count: "1",
              });
              writeClientPacket("command_request", {
                command: command.startsWith("/") ? command : `/${command}`,
                origin: { type: "player", uuid: crypto.randomUUID(), request_id: "", player_entity_id: 0n },
                internal: false,
                version: "latest",
              });
            };
            runAutoKickAfterDiscovery = runAutoKick;
            const processFriendRequests = async () => {
              if (friendRequestProcessing) return;
              friendRequestProcessing = true;
              try {
              const action = actionMap[accountId];
              const shouldSend = action?.autoFriendRequestPlayers === true || action?.sendFriendRequests === true;
              const shouldAccept = action?.autoAcceptFriendRequests === true;
              if (!shouldSend && !shouldAccept) return;
              const token = await account.authflow.getXboxToken();
              const response = await account.rest.get("https://peoplehub.xboxlive.com/users/me/people/social/decoration/detail", { contractVersion: "3" });
              const people = Array.isArray(response?.people) ? response.people : [];
              const friends = new Set(people
                .filter((person: any) => person.isFollowingCaller === true && person.isFollowedByCaller === true)
                .map((person: any) => extractXuid(person))
                .filter((xuid: string | undefined): xuid is string => Boolean(xuid)));
              if (shouldAccept) {
                for (const person of people) {
                  const xuid = extractXuid(person);
                  if (!xuid || person.isFollowedByCaller !== true || person.isFollowingCaller === true) continue;
                  const result = await fetch(`https://social.xboxlive.com/users/me/people/friends/v2/xuid(${encodeURIComponent(xuid)})`, { method: "PUT", headers: { Authorization: `XBL3.0 x=${token.userHash};${token.XSTSToken}` } });
                  if (result.ok || result.status === 409) log(`${account.profile.gamertag}: 受信したフレンド申請を承認しました (${xuid})`, "success");
                  await wait(1000);
                }
              }
              if (shouldSend) {
                // player_list/add_player/listの到着順に依存せず、
                // その時点で既知の全プレイヤーを対象にする。
                for (const [rawXuid, gamertag] of knownPlayers) {
                  let xuid = rawXuid;
                  // Geyser/FloodgateはJavaプレイヤー名の衝突回避用に、
                  // Bedrock側へ先頭「.」を付けて通知することがある。
                  // フレンド申請名・コマンド対象には補正前の名前を使う。
                  const correctedGamertag = normalizeServerUsername(gamertag);
                  // /list由来の項目はXUIDを持たないため、ゲーマータグから解決する。
                  if (!/^\d{16}$/.test(xuid)) {
                    const profile = await account.rest.getProfile(correctedGamertag).catch(() => undefined);
                    const profileUser = profile?.profileUsers?.[0] ?? profile;
                    xuid = extractXuid(profileUser) ?? String(profileUser?.id ?? "");
                  }
                  if (!/^\d{16}$/.test(xuid) || xuid === accountXuid || requestedPlayers.has(xuid)) continue;
                  // friends.has(xuid) は「現在の1アカウント」の状態です。
                  // ここで全体をスキップすると、複数アカウントのうち
                  // 片方だけがフレンド済みの場合、もう片方にも申請されません。
                  const queuedAccounts = await enqueueFriendRequestForEnabledAccounts(
                    xuid,
                    correctedGamertag,
                    friends.has(xuid) ? accountId : undefined,
                  );
                  requestedPlayers.add(xuid);
                  for (const queuedAccountId of queuedAccounts) {
                    const queuedAccount = accounts.get(queuedAccountId);
                    log(`${queuedAccount?.profile.gamertag ?? queuedAccountId}: ${correctedGamertag} をフレンド申請待機列へ追加しました。`, "info");
                  }
                }
              }
              // 申請送信は接続処理とは分離し、friendRequests.jsonの待機列を
              // バックグラウンドワーカーが順番に処理する。
              scheduleFriendRequestWorker();
              const queue = await loadFriendRequestQueue();
              const pending = queue.filter((item) => item.accountId === accountId && item.state === "pending");
              void pending;
              } finally { friendRequestProcessing = false; }
            };
            const scheduleFriendRequestProcessing = () => {
              const action = actionMap[accountId];
              if (action?.autoFriendRequestPlayers !== true && action?.sendFriendRequests !== true && action?.autoAcceptFriendRequests !== true) return;
              if (friendRequestDebounceTimer) clearTimeout(friendRequestDebounceTimer);
              friendRequestDebounceTimer = setTimeout(() => {
                friendRequestDebounceTimer = undefined;
                void processFriendRequests().catch((error) => log(`${account.profile.gamertag}: フレンド申請処理エラー ${String(error)}`, "warning"));
              }, 1800);
            };
            finishFriendRequests = processFriendRequests;
            const friendRequestRetryTimer = setInterval(() => {
              void processFriendRequests().catch((error) => log(`${account.profile.gamertag}: フレンド申請処理エラー ${String(error)}`, "warning"));
            }, 15_000);
            connectionTimeout = setTimeout(
              () => failConnection(new Error("AUTOKICK_CONNECT_TIMEOUT")),
              30_000,
            );
            // transfer後の旧NetherNetやRakNetから遅れて複数回errorが届くことがある。
            // onceでは2回目以降がUnhandled 'error'になるため、接続の後始末まで
            // 常駐リスナーで受ける。failConnection側はsettledで重複処理を抑制する。
            client.on("error", (error: unknown) => {
              log(`${account.profile.gamertag}: 接続エラー ${error instanceof Error ? error.message : String(error)}`, "error");
              failConnection(error);
            });
            client.once("kick", (packet: any) => {
              const reason = JSON.stringify(packet ?? "");
              const kickMessage = String(packet?.message ?? "");
              if (kickMessage.includes("NullPointerException") || kickMessage.includes("combined") && kickMessage.includes("lastIndexOf")) {
                const message = `${account.profile.gamertag}: Geyserサーバーがログイン情報を処理できず切断しました。リソースパック応答を修正済みです。`;
                log(message, "error");
                failConnection(new Error(`AUTOKICK_GEYSER_LOGIN_ERROR:${message}`));
                return;
              }
              if (packet?.reason === "host_disconnected") {
                const message = `${account.profile.gamertag}: ホストがサーバーを終了したため、ワールドから退出しました。`;
                log(message, "warning");
                failConnection(new Error(`AUTOKICK_HOST_DISCONNECTED:${message}`));
                return;
              }
              if (packet?.reason === "server_full") {
                const message = `${account.profile.gamertag}: このワールドは満員のため参加できません。参加枠が空いてから再試行してください。`;
                log(message, "warning");
                failConnection(new Error(message));
                return;
              }
              log(`${account.profile.gamertag}: サーバーから切断されました ${reason}`, "error");
              failConnection(new Error(`AUTOKICK_SERVER_KICK:${reason}`));
            });
            client.once("close", (reason: unknown) => {
              finishAutoKickDiscovery();
              clientOpen = false;
              clearDelayedDiscovery();
              if (friendRequestDebounceTimer) clearTimeout(friendRequestDebounceTimer);
              if (hostAutoKickTimer) clearInterval(hostAutoKickTimer);
              failConnection(new Error(`AUTOKICK_CONNECTION_CLOSED:${String(reason ?? "unknown")}`));
            });
            const markWorldReady = (source: "player_spawn" | "start_game_fallback") => {
              if (!completeConnection()) return;
              actionReady = true;
              log(`${account.profile.gamertag}: ${source === "player_spawn" ? "player_spawn" : "start_gameからのフォールバック"}を検出、即時アクション処理へ進みます。`, "info");
              if (actionMap[accountId]?.autoKickHostOnly && !hostAutoKickTimer) {
                runHostAutoKick();
                hostAutoKickTimer = setInterval(runHostAutoKick, Math.max(150, Number(actionMap[accountId]?.intervalMs ?? 1000)));
              }
              writeClientPacket("set_local_player_as_initialized", {
                runtime_entity_id: 0n,
              });
              listRequestPending = true;
              writeClientPacket("command_request", {
                command: "/list",
                origin: { type: "player", uuid: crypto.randomUUID(), request_id: "", player_entity_id: 0n },
                internal: false,
                version: "latest",
              });
            };
              client.on("connect_allowed", () => log(`${account.profile.gamertag}: NetherNet接続を許可されました。`, "info"));
              client.on("network_settings", () => log(`${account.profile.gamertag}: ネットワーク設定を受信しました。`, "info"));
              client.on("resource_packs_info", () => log(`${account.profile.gamertag}: リソースパック情報を受信しました。`, "info"));
              client.on("start_game", () => {
                log(`${account.profile.gamertag}: ワールド開始情報を受信しました。`, "info");
                // 一部のフレンドワールドでは start_game/add_player まで届くのに
                // play_status=player_spawn が送られないことがある。通常の
                // player_spawnを優先し、一定時間後だけ安全なフォールバックを使う。
                if (!spawnFallbackTimer) {
                  const fallbackTransport = client.options?.transport;
                  spawnFallbackTimer = setTimeout(() => {
                    if (!settled && client.options?.transport === fallbackTransport) markWorldReady("start_game_fallback");
                  }, 3000);
                }
              });
            client.on("transfer", (data: any) => log(`${account.profile.gamertag}: 外部サーバーへ転送します (${String(data?.server_address ?? "?")}:${String(data?.port ?? "?")})`, "info"));
            client.on("transfer_start", (data: any) => {
              // transfer前のSession Directory側start_gameで設定した
              // フォールバックを転送先RakNetへ持ち越さない。
              if (spawnFallbackTimer) {
                clearTimeout(spawnFallbackTimer);
                spawnFallbackTimer = undefined;
              }
              log(`${account.profile.gamertag}: 転送先RakNetへ接続を開始しました (${String(data?.server_address ?? "?")}:${String(data?.port ?? "?")})`, "info");
            });
            client.on("transfer_error", (data: any) => log(`${account.profile.gamertag}: 転送先サーバーへの接続に失敗しました (${data?.error instanceof Error ? data.error.message : String(data?.error ?? "unknown")})`, "error"));
            client.on("play_status", (data: any) => {
                log(`${account.profile.gamertag}: play_status=${data.status ?? "unknown"}`, "info");
              if (data.status === "player_spawn") {
                if (client.options?.transport === "DEFAULT" && spawnFallbackTimer) {
                  clearTimeout(spawnFallbackTimer);
                  spawnFallbackTimer = undefined;
                }
                markWorldReady("player_spawn");
              }
            });
            client.on("text", (packet: any) => {
              const message = String(packet.message ?? packet.filtered_message ?? packet.text ?? "").trim();
              if (!message) return;
              emit?.({ type: "chat", accountId, source: String(packet.source_name ?? packet.name ?? "不明"), message });
            });
            client.on("player_list", (packet: any) => {
              for (const record of packet.records ?? []) {
                const player = normalizePlayer(record, account.profile);
                const key = String(player?.xuid ?? record.uuid ?? "");
                if (record.type === "remove") {
                  const removedName = playerNames.get(key);
                  knownPlayers.delete(key);
                  playerNames.delete(key);
                  if (removedName) emit?.({ type: "chat", accountId, source: "システム", message: `${removedName} が退出しました。` });
                } else if (player) {
                  knownPlayers.set(key, String(player.gamertag));
                  playerNames.set(key, String(player.gamertag));
                }
              }
              const players = (packet.records ?? []).filter((record: any) => record.type !== "remove").map((record: any) => normalizePlayer(record, account.profile));
              emit?.({ type: "players", accountId, players: players.filter(Boolean) });
              log(`${account.profile.gamertag}: player_listを受信 (${players.filter(Boolean).length}人)。`, "info");
              // player_listは複数パケットに分割されるため、空のパケットでは
              // 検出完了にしない。実際の一覧確定は/listのcommand_outputで行う。
              if (players.some(Boolean)) listDiscoveryReady = true;
              runAutoKick();
            });
            client.on("add_player", (packet: any) => {
              const player = normalizePlayer(packet, account.profile);
              if (player) {
                knownPlayers.set(String(player.xuid), String(player.gamertag));
                playerNames.set(String(player.xuid), String(player.gamertag));
                scheduleFriendRequestProcessing();
                emit?.({ type: "players", accountId, players: [player] });
                log(`${account.profile.gamertag}: add_playerを受信 (${String(player.gamertag)})。`, "info");
                emit?.({ type: "chat", accountId, source: "システム", message: `${String(player.gamertag)} が参加しました。` });
                // /listの結果を受信するまでは開始しない。
              }
            });
            client.on("remove_player", (packet: any) => {
              const id = String(packet.uuid ?? packet.xbox_user_id ?? packet.entity_unique_id ?? "");
              if (id) emit?.({ type: "players", accountId, players: [{ xuid: id, uuid: id, gamertag: "", removed: true }] });
              const name = String(packet.username ?? packet.name ?? packet.gamertag ?? playerNames.get(id) ?? "").trim();
              if (name) emit?.({ type: "chat", accountId, source: "システム", message: `${name} が退出しました。` });
            });
            client.on("command_output", (packet: any) => {
              const message = extractCommandOutput(packet);
              if (message) emit?.({ type: "command-response", accountId, message });
              const listedPlayers = parseListPlayers(message);
              const isListResponse = /players?\s+online|online\s*:/i.test(message);
              if (listRequestPending && (listedPlayers.length || isListResponse || message.length > 0)) {
                listRequestPending = false;
                for (const gamertag of listedPlayers) {
                  const cleaned = cleanGamertag(gamertag);
                  if (cleaned) knownPlayers.set(`list:${cleaned.toLocaleLowerCase()}`, cleaned);
                }
                listDiscoveryReady = true;
                scheduleFriendRequestProcessing();
                // /listの結果を取り込んだ直後に実行する。
                runAutoKick();
                log(`${account.profile.gamertag}: /listでプレイヤー${listedPlayers.length}人を検出しました。`, "info");
                emit?.({ type: "players", accountId, players: listedPlayers.map((gamertag) => ({ xuid: `list:${gamertag}`, gamertag, isOwnBot: gamertag === account.profile.gamertag })) });
                if (actionMap[accountId]?.autoKickEnabled && !actionMap[accountId]?.autoKickHostOnly && !autoKickStarted) finishAutoKickDiscovery();
              }
              const playerEvent = message.match(/(?:%multiplayer\.player\.|multiplayer\.player\.)(left|joined)\s*[:：]?\s*(.+)$/i);
              if (playerEvent) {
                const action = playerEvent[1]?.toLocaleLowerCase() === "left" ? "退出" : "参加";
                const name = cleanGamertag(playerEvent[2] ?? "");
                if (name && !name.startsWith("%")) emit?.({ type: "chat", accountId, source: "システム", message: `${name} が${action}しました。` });
              }
              const text = JSON.stringify(packet.output ?? packet).toLocaleLowerCase();
              if (text.includes("permission") || text.includes("権限") || text.includes("operator")) {
                emit?.({ type: "operator", accountId, isOperator: false });
              }
            });
          }).catch(async (error: unknown) => {
            if (connectionTimeout) clearTimeout(connectionTimeout);
            const refreshTimer = tokenRefreshTimers.get(accountId);
            if (refreshTimer) {
              clearInterval(refreshTimer);
              tokenRefreshTimers.delete(accountId);
            }
            clientOpen = false;
            clearDelayedDiscovery();
            try { client.close(`connect-failed:${error instanceof Error ? error.message : String(error)}`); } catch { /* 再試行前の後始末 */ }
            clients.delete(accountId);
            const retryable = error instanceof Error && (
              error.message === "AUTOKICK_CONNECT_TIMEOUT" ||
              error.message.includes("CONNECTRESPONSE待機がタイムアウト") ||
              error.message.includes("NetherNet CONNECTERROR") ||
              error.message.includes("Session Directoryにこのアカウントのnonceが登録されませんでした") ||
              error.message.includes("nonceを取得できない")
            );
            if (retryable && retryAttempt < 2) {
              log(`${account.profile.gamertag}: NetherNet接続を再試行します (${retryAttempt + 1}/2)。原因: ${error instanceof Error ? error.message : String(error)}`, "warning");
              await refreshAuthTokens(account.authflow, account.profile.gamertag, log);
              // 同じSession Directoryのnonce・PmsgIdを直ちに再利用せず、
              // members.meの反映と古いsignaling接続の破棄を待つ。
              await new Promise((resolve) => setTimeout(resolve, 5000 * (retryAttempt + 1)));
              await this.startSession([accountId], worldId, options, log, emit, plugins, retryAttempt + 1);
              return;
            }
            throw error instanceof Error ? error : new Error(String(error));
          });
          // player_spawn直後にPromiseが完了しても、その直後にhost_disconnectedや
          // closeが届く場合がある。閉じた接続を参加成功として扱わず、後続の
          // AutoKick・チャット・フレンド処理へ進ませない。
          if (!clientOpen) {
            clients.delete(accountId);
            actionWorkers.get(accountId)?.abort();
            actionWorkers.delete(accountId);
            throw new Error(`${account.profile.gamertag}: ワールド参加直後に接続が終了しました。`);
          }
          log(`${account.profile.gamertag}: アクション処理を開始します。`, "info");
          // /listの結果が既に届いていれば、spawn直後に即時実行する。
          // まだ届いていない場合は、command_output受信時に実行する。
          if (actionMap[accountId]?.autoKickEnabled) runAutoKickAfterDiscovery();
          if (actionMap[accountId]?.autoKickEnabled && !actionMap[accountId]?.autoKickHostOnly && !autoKickStarted) {
            // 固定時間ではなく、/listのcommand_outputまたはplayer_listを
            // 受信した瞬間に判定する。通信が閉じた場合もイベントで解除する。
            await autoKickDiscovery;
            if (!clientOpen) throw new Error(`${account.profile.gamertag}: AutoKick監視中に接続が終了しました。`);
            runAutoKickAfterDiscovery();
          }
          if (actionMap[accountId]?.autoKickEnabled && !actionMap[accountId]?.autoKickHostOnly && !autoKickStarted) {
            log(`${account.profile.gamertag}: AutoKick対象プレイヤーが見つかりませんでした。`, "warning");
          }
          if (!clientOpen) throw new Error(`${account.profile.gamertag}: アクション開始前に接続が終了しました。`);
          log(`${account.profile.gamertag} がワールドへ参加しました。`, "success");
          const action = actionMap[accountId];
          const isLive = options && typeof options === "object" && (options as Record<string, unknown>).live === true;
          log(`${account.profile.gamertag}: アクション設定 kind=${String(action?.kind ?? "none")} autoKick=${String(action?.autoKickEnabled ?? false)} command=${JSON.stringify(action?.autoKickEnabled ? getAutoKickCommand(action) : (action?.autoKickCommand ?? ""))}`, "info");
          if (!isLive && action?.kind && action.kind !== "none") {
            const executionSteps = action.steps?.length
              ? action.steps.map((step: any, index: number) => index === 0 ? { ...step, count: action.count ?? step.count } : step)
              : [action];
            const executeStep = async (step: any, signal?: AbortSignal): Promise<void> => {
              const stepCount = Number(step.count ?? 1);
              const limit = stepCount === -1 ? Number.POSITIVE_INFINITY : Math.min(9999, Math.max(1, stepCount));
              for (
                let index = 0;
                index < limit;
                index += 1
              ) {
                if (signal?.aborted || !clientOpen) return;
                const target = [...knownPlayers.values()].find((name) => cleanGamertag(name).toLocaleLowerCase() !== cleanGamertag(account.profile.gamertag).toLocaleLowerCase());
                const message = expandPlaceholders(step.message, target ? quoteCommandTarget(target) : target);
                if (step.kind === "chat") {
                  const chunks = splitBedrockChat(message);
                  for (const chunk of chunks) {
                    const sent = writeClientPacket("text", {
                      category: "authored",
                      type: "chat",
                      needs_translation: false,
                      source_name: account.profile.gamertag,
                      message: chunk,
                      xuid: String(accountXuid),
                      platform_chat_id: "",
                      has_filtered_message: false,
                    });
                    if (!sent) throw new Error("チャット送信チャネルが閉じています。");
                    if (chunks.length > 1) await wait(100);
                  }
                  log(`${account.profile.gamertag}: 即時チャットを送信しました (${Array.from(message).length}文字${chunks.length > 1 ? `・${chunks.length}分割` : ""})。`, "info");
                } else if (step.kind === "command") {
                  const sent = writeClientPacket("command_request", {
                    command: message.startsWith("/") ? message : `/${message}`,
                    origin: {
                      type: "player",
                      uuid: crypto.randomUUID(),
                      request_id: "",
                      player_entity_id: 0n,
                    },
                    internal: false,
                    version: "latest",
                  });
                  if (!sent) throw new Error("コマンド送信チャネルが閉じています。");
                } else if (step.kind === "script" && plugins && step.scriptId && step.scriptAction) {
                  log(`${account.profile.gamertag}: スクリプト ${step.scriptId}/${step.scriptAction} を実行します。`, "info");
                  try {
                    await plugins.run(step.scriptId, step.scriptAction, {
                    accountId,
                    account: account.profile,
                    api: {
                      log: (message: string) => log(`${account.profile.gamertag}: [script] ${message}`, "info"),
                      chat: async (message: string) => { for (const chunk of splitBedrockChat(message)) { writeClientPacket("text", { category: "authored", type: "chat", needs_translation: false, source_name: account.profile.gamertag, message: chunk, xuid: String(accountXuid), platform_chat_id: "", has_filtered_message: false }); await wait(100); } },
                      command: async (command: string) => { client.write("command_request", { command: command.startsWith("/") ? command : `/${command}`, origin: { type: "player", uuid: crypto.randomUUID(), request_id: "", player_entity_id: 0n }, internal: false, version: "latest" }); },
                      players: () => [],
                    },
                    });
                    log(`${account.profile.gamertag}: スクリプト ${step.scriptId}/${step.scriptAction} が完了しました。`, "success");
                  } catch (error) {
                    log(`${account.profile.gamertag}: スクリプトエラー ${error instanceof Error ? error.message : String(error)}`, "error");
                    throw error;
                  }
                }
                // 連続送信が同一Reliable channelへ集中しないよう、
                // 最低50msの間隔を維持する。
                await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(action.intervalMs ?? 50))));
              }
            };
            const workerController = new AbortController();
            actionWorkers.set(accountId, workerController);
            const workers = executionSteps.map((step: any) => executeStep(step, workerController.signal));
            if (action.executionMode === "parallel") {
              await Promise.all(workers);
            } else {
              for (const worker of workers) await worker;
            }
            actionWorkers.delete(accountId);
          }
          if (!isLive && action?.autoKickEnabled && autoKickStarted) {
            log(`${account.profile.gamertag}: AutoKick完了待ちを開始します。`, "info");
            await autoKickCompletion;
            log(`${account.profile.gamertag}: AutoKick完了待ちが終了しました。`, "info");
          }
          // add_playerが退出直前に届くサーバーがあるため、最後に全員分を再走査する。
          // これを待たずにautoExitすると、最初の1人だけ申請される場合がある。
          if (action?.autoFriendRequestPlayers === true || action?.sendFriendRequests === true || action?.autoAcceptFriendRequests === true) await finishFriendRequests();
          if (action?.autoExit !== false && !(options && typeof options === "object" && (options as Record<string, unknown>).live === true)) {
            // write()は内部で非同期チャネルへ投入されるため、送信直後にcloseすると
            // 長文チャットがフラッシュされる前に破棄されることがある。
            if (!isLive && action?.kind && action.kind !== "none") await wait(750);
            clientOpen = false;
            if (hostAutoKickTimer) clearInterval(hostAutoKickTimer);
            client.close("automation-complete");
            clients.delete(accountId);
            actionWorkers.get(accountId)?.abort();
            actionWorkers.delete(accountId);
            log(`${account.profile.gamertag} が退出しました。`);
          }
        })();
      }
    },
    async sendLive(accountId, message, kind) {
      const client = clients.get(accountId);
      if (!client) throw new Error("ライブ接続中のアカウントがありません。");
      const account = accounts.get(accountId);
      if (kind === "chat") {
        const safeMessage = truncateBedrockChat(message);
        client.write("text", { category: "authored", type: "chat", needs_translation: false, source_name: account?.profile.gamertag ?? "", message: safeMessage, xuid: String(account?.profile.xuid ?? ""), platform_chat_id: "", has_filtered_message: false });
      }
      else client.write("command_request", { command: message.startsWith("/") ? message : `/${message}`, origin: { type: "player", uuid: crypto.randomUUID(), request_id: "", player_entity_id: 0n }, internal: false, version: "latest" });
    },
    async stopLive(accountId) { actionWorkers.get(accountId)?.abort(); actionWorkers.delete(accountId); const client = clients.get(accountId); if (client) { client.close("live-stop"); clients.delete(accountId); } const timer = tokenRefreshTimers.get(accountId); if (timer) { clearInterval(timer); tokenRefreshTimers.delete(accountId); } },
    async stopAll() {
      for (const [accountId, client] of clients) {
        actionWorkers.get(accountId)?.abort();
        actionWorkers.delete(accountId);
        try { client.close("backend-shutdown"); } catch { /* 終了処理を継続 */ }
        clients.delete(accountId);
      }
      for (const timer of tokenRefreshTimers.values()) clearInterval(timer);
      tokenRefreshTimers.clear();
    },
  };
}

function extractCommandOutput(packet: any): string {
  const output = packet?.output ?? packet;
  if (typeof output === "string") return output;
  // BedrockXのcommand_outputは messagesではなく、
  // { message_id, success, parameters } の配列として返る。
  const records = Array.isArray(output) ? output : Array.isArray(output?.messages) ? output.messages : [output];
  const values = records.map((item: any) => {
    if (typeof item === "string") return item;
    const parameters = Array.isArray(item?.parameters) ? item.parameters.join(" ") : "";
    return parameters || (item?.message ?? item?.text ?? item?.message_id ?? "");
  }).filter((value: unknown) => typeof value === "string" && value.trim().length > 0);
  const data = typeof packet?.data === "string" ? packet.data : "";
  return [...values, data].filter(Boolean).join("\n");
}

function parseListPlayers(message: string): string[] {
  const match = message.match(/(?:players?\s+online|online)\s*:\s*(.+)$/im);
  const source = match?.[1] ?? message.match(/^\s*\d+\s+\d+\s+(.+)$/m)?.[1];
  if (!source) return [];
  return source
    .split(/,\s*|\s+and\s+/i)
    .map((name) => normalizeServerUsername(name))
    .filter((name) => name.length > 0 && !/^\d+$/.test(name));
}

function normalizePlayer(record: any, profile: AccountProfile): Record<string, unknown> | undefined {
  const gamertag = [record.username, record.name, record.gamertag, record.player_name]
    .find((value) => typeof value === "string" && value.trim().length > 0);
  if (!gamertag) return undefined;
  const correctedGamertag = normalizeServerUsername(gamertag);
  const xuid = String(record.xbox_user_id ?? record.xuid ?? record.uuid ?? record.entity_unique_id ?? `name:${correctedGamertag}`);
  return {
    xuid,
    uuid: record.uuid,
    gamertag: correctedGamertag,
    isOwnBot: xuid === profile.xuid || correctedGamertag === profile.gamertag,
    // player_listのpermissionはBedrockでは数値の場合がある
    // (visitor=0, member=1, operator=2, host=3)。
    isOperator: record.permission === "operator" ||
      record.permission === "operator_command" ||
      (typeof record.permission === "number" && record.permission >= 2) ||
      record.isOperator === true,
  };
}

function cleanGamertag(value: string): string {
  return value
    .replace(/§[0-9a-fk-or]/gi, "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
}

function normalizeServerUsername(value: string): string {
  const cleaned = cleanGamertag(String(value));
  // Geyser/FloodgateはJavaプレイヤー名をBedrock側へ渡す際、
  // 識別用の先頭ドットを付け、名前中のスペースをアンダースコアへ変換する。
  // Xboxプロフィール検索・コマンド対象には統合版側の正規表記を使う。
  const isGeyserName = cleaned.startsWith(".");
  const withoutPrefix = isGeyserName ? cleaned.slice(1).trim() : cleaned;
  return isGeyserName
    ? withoutPrefix.replaceAll("_", " ").replace(/\s+/g, " ").trim()
    : withoutPrefix;
}

function quoteCommandTarget(value: string): string {
  const cleaned = cleanGamertag(value).replaceAll('"', "");
  return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

function replaceCommandPlaceholders(template: string, values: Record<string, string>): string {
  return template.replace(/\{(me|random|player|host|count)\}/gi, (match, key: string, offset: number, source: string) => {
    const value = values[key.toLocaleLowerCase()] ?? "";
    const before = source[offset - 1] ?? "";
    const after = source[offset + match.length] ?? "";
    // 設定値側で既に引用符を付けている場合は二重引用符にしない。
    return before === '"' || after === '"' ? cleanGamertag(value).replaceAll('"', "") : quoteCommandTarget(value);
  });
}

function buildAutoKickCommand(template: string, values: Record<string, string>): string {
  const expanded = replaceCommandPlaceholders(template, values);
  // AutoKickのセレクターは常に固定する。設定に
  // @a[name="{player}"] や別の条件があっても、対象選択条件を変えない。
  return expanded
    .replace(/@a\s*\[[^\]]*\]/gi, "@a[name=a]")
    .replace(/@a(?!\s*\[name=a\])/gi, "@a[name=a]");
}

