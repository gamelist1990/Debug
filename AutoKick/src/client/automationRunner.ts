import type {
  AccountProfile,
  AutomationOptions,
  ClientLog,
  SessionClient,
  WorldSession,
} from "./types";

export interface AutomationRunner {
  run(
    accounts: AccountProfile[],
    world: WorldSession,
    options: AutomationOptions,
  ): Promise<void>;
  onLog(listener: (log: ClientLog) => void): () => void;
}

export function createAutomationRunner(
  createClient: (account: AccountProfile) => Promise<SessionClient>,
): AutomationRunner {
  const listeners = new Set<(log: ClientLog) => void>();
  const emit = (message: string, level: ClientLog["level"] = "info") =>
    listeners.forEach((listener) =>
      listener({ timestamp: new Date().toISOString(), level, message }),
    );
  return {
    async run(accounts, world, options) {
      if (!accounts.length)
        throw new Error("アカウントを1つ以上選択してください。");
      await Promise.all(
        accounts.map(async (account) => {
          const client = await createClient(account);
          const unsubscribe = client.onLog((log) =>
            listeners.forEach((listener) => listener(log)),
          );
          try {
            await client.connect(world);
            await client.send(options);
            if (options.autoExit) await client.disconnect();
          } finally {
            unsubscribe();
          }
        }),
      );
      emit(`${accounts.length} アカウントの自動化が完了しました。`, "success");
    },
    onLog(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
