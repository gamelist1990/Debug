export type BackendRequest =
  | { type: "list-accounts"; requestId: string }
  | { type: "begin-login"; requestId: string }
  | { type: "list-plugins"; requestId: string }
  | { type: "load-config"; requestId: string }
  | { type: "save-config"; requestId: string; config: unknown }
  | { type: "remove-account"; requestId: string; accountId: string }
  | { type: "list-worlds"; requestId: string; accountId: string }
  | { type: "search-friends"; requestId: string; accountId: string; query: string }
  | { type: "add-friend"; requestId: string; accountId: string; xuid: string }
  | { type: "list-friend-request-queue"; requestId: string; accountId?: string }
  | { type: "ping"; requestId: string }
  | {
      type: "start-session";
      requestId: string;
      accountIds: string[];
      worldId: string;
      options: unknown;
      joinMode?: "single-world-all" | "one-account-per-world";
      assignments?: Array<{ worldId: string; accountIds: string[] }>;
    }
  | {
      type: "start-auto-session";
      requestId: string;
      accountIds: string[];
      worlds: Array<{ id: string; ownerGamertag: string; accountIds?: string[] }>;
      options: unknown;
    }
  | {
      type: "start-external-session";
      requestId: string;
      host: string;
      port: number;
      accountIds: string[];
      options: unknown;
    }
  | { type: "stop-session"; requestId: string }
  | { type: "live-send"; requestId: string; accountId: string; message: string; kind: "chat" | "command" }
  | { type: "live-start"; requestId: string; accountIds: string[]; worldId: string }
  | { type: "live-stop"; requestId: string; accountId: string };

export type BackendEvent =
  | { type: "ready"; version: string }
  | { type: "accounts"; requestId: string; accounts: unknown[] }
  | { type: "auth-code"; requestId: string; verificationUri: string; userCode: string }
  | { type: "plugins"; requestId: string; plugins: unknown[] }
  | { type: "config"; requestId: string; config: unknown }
  | { type: "worlds"; requestId: string; worlds: unknown[] }
  | { type: "friend-results"; requestId: string; people: unknown[] }
  | { type: "friend-request-queue"; requestId: string; requests: Array<{ xuid: string; gamertag: string; sent: unknown[]; pending: unknown[] }> }
  | { type: "pong"; requestId: string }
  | {
      type: "session-log";
      timestamp: string;
      level: "info" | "success" | "warning" | "error";
      message: string;
    }
  | {
      type: "session-state";
      state: "idle" | "running" | "stopped" | "error";
      message?: string;
    }
  | { type: "error"; requestId?: string; message: string }
  | { type: "players"; accountId: string; players: unknown[] }
  | { type: "chat"; accountId: string; source: string; message: string }
  | { type: "command-response"; accountId: string; message: string }
  | { type: "operator"; accountId: string; isOperator: boolean };
  

export function encode(message: BackendRequest): string {
  return `${JSON.stringify(message)}\n`;
}
export function decode(line: string): BackendEvent {
  return JSON.parse(line) as BackendEvent;
}
