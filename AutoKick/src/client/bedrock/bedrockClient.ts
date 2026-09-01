import type { AccountProfile, AutomationAction, ClientLog, SessionClient, WorldSession } from "../types";

export interface BedrockTransport {
  connect(account: AccountProfile, session: WorldSession): Promise<void>;
  writeText(account: AccountProfile, action: AutomationAction): Promise<void>;
  close(account: AccountProfile, reason: string): Promise<void>;
}

/** BedrockX/bedrock-protocolへの接続境界。UIやXbox APIを参照しない。 */
export function createBedrockClient(account: AccountProfile, transport: BedrockTransport): SessionClient {
  const listeners = new Set<(log: ClientLog) => void>();
  const emit = (level: ClientLog["level"], message: string) => listeners.forEach((listener) => listener({ timestamp: new Date().toISOString(), level, message }));
  return {
    async connect(session) { emit("info", `${account.gamertag} が ${session.name} へ接続しています。`); await transport.connect(account, session); emit("success", `${account.gamertag} がワールドへ参加しました。`); },
    async send(action) { for (let index = 0; index < action.count; index += 1) { await transport.writeText(account, action); emit("info", `${account.gamertag}: ${action.kind === "command" ? "/" : ""}${action.message} (${index + 1}/${action.count})`); } },
    async disconnect(reason = "automation-complete") { await transport.close(account, reason); emit("success", `${account.gamertag} が退出しました。`); },
    onLog(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export function createBedrockTransport(): BedrockTransport {
  return {
    async connect() { /* TODO: test/index.ts のBedrockX生成処理を移植 */ },
    async writeText() { /* TODO: play_status後のtext/command_requestを移植 */ },
    async close() { /* TODO: client.close(reason)を移植 */ },
  };
}
