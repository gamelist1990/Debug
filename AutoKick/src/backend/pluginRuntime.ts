import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAutoKickPluginsDir } from "./dataPaths.ts";

export interface AutoKickPlugin {
  name?: string;
  version?: string;
  actions?: Record<
    string,
    (context: Record<string, unknown>) => unknown | Promise<unknown>
  >;
}
export interface AutoKickPluginApi {
  log(message: string): void;
  chat(message: string): Promise<void>;
  command(command: string): Promise<void>;
  players(): Array<Record<string, unknown>>;
  paths: { dataDir: string; pluginsDir: string; configPath: string; tokensPath: string };
}
export interface PluginRuntime {
  list(): Promise<Array<{ id: string; name: string; version?: string; actions: string[] }>>;
  run(
    id: string,
    action: string,
    context: Record<string, unknown>,
  ): Promise<void>;
}
export function createPluginRuntime(): PluginRuntime {
  const root = getAutoKickPluginsDir();
  const loaded = new Map<string, AutoKickPlugin>();
  return {
    async list() {
      if (!existsSync(root)) return [];
      const files = (await readdir(root)).filter((file) =>
        file.endsWith(".js"),
      );
      const result = [];
      for (const file of files) {
        const id = file.slice(0, -3);
        try {
          const module = await import(pathToFileURL(join(root, file)).href);
          const plugin = (module.default ?? module) as AutoKickPlugin;
          loaded.set(id, plugin);
          result.push({ id, name: plugin.name ?? id, version: plugin.version, actions: Object.keys(plugin.actions ?? {}) });
        } catch {
          /* 不正なプラグインは一覧から除外 */
        }
      }
      return result;
    },
    async run(id, action, context) {
      const plugin = loaded.get(id);
      if (!plugin) throw new Error(`プラグイン ${id} が見つかりません。`);
      const handler = plugin.actions?.[action];
      if (!handler)
        throw new Error(
          `プラグイン ${id} にアクション ${action} がありません。`,
        );
      await handler(context);
    },
  };
}
