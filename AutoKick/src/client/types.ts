export type AccountStatus = "online" | "offline" | "connecting";

export interface AccountProfile {
  id: string;
  gamertag: string;
  xuid?: string;
  avatarUrl?: string;
  status: AccountStatus;
  loggedInAt?: string;
  worldJoinCount?: number;
  friendCount?: number;
}

export type AccountJoinMode = "single-world-all" | "one-account-per-world";

export interface WorldSession {
  id: string;
  name: string;
  ownerGamertag: string;
  source: "friend" | "friend-of-friend";
  players: number;
  maxPlayers?: number;
  version?: string;
  availableAccountIds?: string[];
}

export interface WorldPlayer {
  xuid: string;
  gamertag: string;
  avatarUrl?: string;
  isBot?: boolean;
  isFriend?: boolean;
  isOperator?: boolean;
  isOwnBot?: boolean;
}

export interface AutomationAction {
  kind: "none" | "chat" | "command" | "script";
  message: string;
  count: number;
  intervalTicks: number;
  scriptId?: string;
  scriptAction?: string;
}

export interface AutomationOptions extends AutomationAction {
  sendFriendRequests: boolean;
  autoFriendRequestPlayers: boolean;
  autoExit: boolean;
  intervalMs: number;
  executionMode: "parallel" | "sequential";
  steps: AutomationAction[];
  detectOperator: boolean;
  operatorBehavior: "continue" | "skip-command" | "stop";
  autoAcceptFriendRequests: boolean;
  autoKickEnabled: boolean;
  autoKickCommand?: string;
  autoKickHostOnly: boolean;
  placeholderHelp?: boolean;
}

export type AccountAutomationMap = Record<string, AutomationOptions>;

export interface ClientLog {
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

export interface SessionClient {
  connect(session: WorldSession): Promise<void>;
  send(action: AutomationAction): Promise<void>;
  disconnect(reason?: string): Promise<void>;
  onLog(listener: (log: ClientLog) => void): () => void;
}

export interface AccountClientFactory {
  create(account: AccountProfile): Promise<SessionClient>;
}
