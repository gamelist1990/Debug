import type { AccountProfile, AutomationOptions, ClientLog, WorldSession } from "../client/types";

export interface DashboardState {
  accounts: AccountProfile[];
  worlds: WorldSession[];
  selectedAccountIds: string[];
  selectedWorldId: string;
  options: AutomationOptions;
  logs: ClientLog[];
  running: boolean;
}
