import { homedir } from "node:os";
import { join } from "node:path";

/** ユーザーごとのAutoKickデータディレクトリ。環境変数はテスト・ポータブル運用時だけ上書きする。 */
export function getAutoKickDataDir(): string {
  return process.env.AUTOKICK_DATA_DIR?.trim() || join(homedir(), "Documents", "PEXData", "AutoKick");
}
export function getAutoKickPluginsDir(): string { return join(getAutoKickDataDir(), "plugins"); }
export function getAutoKickTokensPath(): string { return join(getAutoKickDataDir(), "tokens.json"); }
export function getAutoKickConfigPath(): string { return join(getAutoKickDataDir(), "config.json"); }
/** フレンド申請キュー。送信済み・保留中の状態を再起動後も維持する。 */
export function getAutoKickFriendRequestsPath(): string { return join(getAutoKickDataDir(), "friendrequest.json"); }
