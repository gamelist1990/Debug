import type { AccountProfile, WorldSession } from "../types";

export interface SessionDirectory {
  listFriendWorlds(account: AccountProfile): Promise<WorldSession[]>;
}

/** Xbox Session Directory APIの境界。実API接続はここへ実装し、UIへ漏らさない。 */
export function createSessionDirectory(): SessionDirectory {
  return {
    async listFriendWorlds(_account) { throw new Error("Session DirectoryはNodeバックエンド経由で取得してください。"); },
  };
}
