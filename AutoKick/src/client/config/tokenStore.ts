import type { AccountProfile } from "../types";

export interface TokenStore {
  listAccounts(): Promise<AccountProfile[]>;
  remove(accountId: string): Promise<void>;
  beginLogin(): Promise<{ verificationUri: string; userCode: string }>;
}

/** 認証情報の永続化はUIや通信実装から分離する。秘密情報を画面へ返さない。 */
export function createTokenStore(): TokenStore {
  let accounts: AccountProfile[] = [];
  return {
    async listAccounts() {
      return accounts;
    },
    async remove(accountId) {
      accounts = accounts.filter((account) => account.id !== accountId);
    },
    async beginLogin() {
      return {
        verificationUri: "https://microsoft.com/devicelogin",
        userCode: "DEMO-CODE",
      };
    },
  };
}
