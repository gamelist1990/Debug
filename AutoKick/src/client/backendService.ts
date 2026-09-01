import { invoke } from "@tauri-apps/api/core";
import { BackendSocket } from "./backendSocket";
import type { AccountProfile, WorldSession } from "./types";
import type { BackendEvent } from "../backend/protocol";

export const backendSocket = new BackendSocket();

export async function listBackendAccounts(): Promise<AccountProfile[]> {
  if (!backendSocket.isConnected()) await startNodeBackend();
  const requestId = crypto.randomUUID();
  const response = await backendSocket.request<Extract<BackendEvent, { type: "accounts" }>>({ type: "list-accounts", requestId }, requestId);
  return response.accounts as AccountProfile[];
}
export async function beginBackendLogin(): Promise<{ verificationUri: string; userCode: string }> {
  if (!backendSocket.isConnected()) await startNodeBackend();
  const requestId = crypto.randomUUID();
  const promise = new Promise<{ verificationUri: string; userCode: string }>((resolve, reject) => { const unsubscribe = backendSocket.on((event) => { if (event.type === "auth-code" && event.requestId === requestId) { unsubscribe(); resolve({ verificationUri: event.verificationUri, userCode: event.userCode }); } if (event.type === "error" && event.requestId === requestId) { unsubscribe(); reject(new Error(event.message)); } }); });
  backendSocket.send({ type: "begin-login", requestId });
  return promise;
}

export async function listBackendWorlds(accountId: string): Promise<WorldSession[]> {
  const requestId = crypto.randomUUID();
  const response = await backendSocket.request<Extract<BackendEvent, { type: "worlds" }>>({ type: "list-worlds", requestId, accountId }, requestId);
  return response.worlds as WorldSession[];
}
export async function listBackendPlugins(): Promise<Array<{ id: string; name: string; version?: string; actions: string[] }>> {
  if (!backendSocket.isConnected()) await startNodeBackend();
  const requestId = crypto.randomUUID();
  const response = await backendSocket.request<Extract<BackendEvent, { type: "plugins" }>>({ type: "list-plugins", requestId }, requestId);
  return response.plugins as Array<{ id: string; name: string; version?: string; actions: string[] }>;
}
export async function loadBackendConfig(): Promise<Record<string, unknown>> {
  if (!backendSocket.isConnected()) await startNodeBackend();
  const requestId = crypto.randomUUID();
  const response = await backendSocket.request<Extract<BackendEvent, { type: "config" }>>({ type: "load-config", requestId }, requestId);
  return (response.config && typeof response.config === "object" ? response.config : {}) as Record<string, unknown>;
}
export async function saveBackendConfig(config: unknown): Promise<void> {
  const requestId = crypto.randomUUID();
  await backendSocket.request({ type: "save-config", requestId, config }, requestId);
}
export async function removeBackendAccount(accountId: string): Promise<void> {
  const requestId = crypto.randomUUID();
  await backendSocket.request({ type: "remove-account", requestId, accountId }, requestId);
}

export async function startNodeBackend(port = 47821): Promise<void> {
  await invoke("start_backend", { request: { port } });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await backendSocket.connect(`ws://127.0.0.1:${port}`); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Node.jsバックエンドの起動を確認できませんでした。");
}

export async function stopNodeBackend(): Promise<void> {
  backendSocket.close();
  await invoke("stop_backend");
}

export async function sendLiveMessage(accountId: string, message: string, kind: "chat" | "command"): Promise<void> {
  const requestId = crypto.randomUUID();
  await backendSocket.request({ type: "live-send", requestId, accountId, message, kind }, requestId);
}

export async function addBackendFriend(accountId: string, xuid: string): Promise<void> {
  const requestId = crypto.randomUUID();
  await backendSocket.request({ type: "add-friend", requestId, accountId, xuid }, requestId);
}

export async function stopLiveSession(accountId: string): Promise<void> {
  const requestId = crypto.randomUUID();
  await backendSocket.request({ type: "live-stop", requestId, accountId }, requestId);
}

export async function stopBackendSession(): Promise<void> {
  const requestId = crypto.randomUUID();
  await backendSocket.request({ type: "stop-session", requestId }, requestId);
}

export async function startLiveSession(accountIds: string[], worldId: string): Promise<void> {
  const requestId = crypto.randomUUID();
  await backendSocket.request({ type: "live-start", requestId, accountIds, worldId }, requestId);
}
