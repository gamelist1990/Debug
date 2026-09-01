import { useEffect, useMemo, useState } from "react";
import type {
  AccountProfile,
  WorldPlayer,
  WorldSession,
} from "../../client/types";
import { addBackendFriend, sendLiveMessage, startLiveSession, stopLiveSession, backendSocket } from "../../client/backendService";

const BEDROCK_CHAT_MAX_LENGTH = 512;
const truncateChat = (value: string) => {
  if (Array.from(value).length <= BEDROCK_CHAT_MAX_LENGTH) return value;
  let result = Array.from(value).slice(0, BEDROCK_CHAT_MAX_LENGTH).join("");
  const last = result.charCodeAt(result.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? result.slice(0, -1) : result;
};

interface Props {
  accounts: AccountProfile[];
  worlds: WorldSession[];
}
export function LiveMode({ accounts, worlds }: Props) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [worldId, setWorldId] = useState(worlds[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [pendingWorldId, setPendingWorldId] = useState<string>();
  const [worldModalOpen, setWorldModalOpen] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(
    accounts.slice(0, 1).map((account) => account.id),
  );
  const [joined, setJoined] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionStep, setConnectionStep] = useState("ワールド参加を準備中…");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [connectionLogs, setConnectionLogs] = useState<string[]>([]);
  const [players, setPlayers] = useState<WorldPlayer[]>([]);
  const [operator, setOperator] = useState(false);
  const [playerActionState, setPlayerActionState] = useState<Record<string, string>>({});
  const [logFilter, setLogFilter] = useState<"all" | "chat" | "command">("all");
  useEffect(() => {
    const firstAccount = accounts[0];
    if (!firstAccount) {
      setSelectedAccounts([]);
      setAccountId("");
      return;
    }
    setSelectedAccounts((current) => {
      const valid = current.filter((id) => accounts.some((account) => account.id === id));
      return valid.length ? valid : [firstAccount.id];
    });
    setAccountId((current) => accounts.some((account) => account.id === current) ? current : firstAccount.id);
  }, [accounts]);
  useEffect(() => {
    const firstWorld = worlds[0];
    if (!firstWorld) {
      setWorldId("");
      return;
    }
    setWorldId((current) => worlds.some((world) => world.id === current) ? current : firstWorld.id);
  }, [worlds]);
  const world = useMemo(
    () => worlds.find((item) => item.id === worldId),
    [worldId, worlds],
  );
  const visibleWorlds = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return worlds;
    const exact = worlds.filter(
      (item) => item.ownerGamertag.toLocaleLowerCase() === query,
    );
    return exact.length
      ? exact
      : worlds.filter((item) =>
          `${item.name} ${item.ownerGamertag}`
            .toLocaleLowerCase()
            .includes(query),
        );
  }, [search, worlds]);
  const send = () => {
    if (!input.trim()) return;
    const kind = input.startsWith("/") ? "command" : "chat";
    const outgoing = kind === "chat" ? truncateChat(input) : input;
    void sendLiveMessage(accountId, outgoing, kind).then(() => setMessages((current) => [...current, `> ${outgoing}${outgoing.length < input.length ? " …(長すぎるため切り詰めました)" : ""}`])).catch((error: unknown) => setMessages((current) => [...current, `! ${error instanceof Error ? error.message : String(error)}`]));
    setInput("");
  };
  useEffect(() => {
    const unsubscribe = backendSocket.on((event) => {
      if (event.type === "players" && event.accountId === accountId) {
        setPlayers((current) => {
          const incoming = event.players as Array<WorldPlayer & { removed?: boolean }>;
          const next = new Map(current.map((player) => [player.xuid, player]));
          for (const player of incoming) {
            if (player.removed) next.delete(player.xuid);
            else if (player.gamertag?.trim()) {
              next.set(player.xuid, player);
              if (player.isOwnBot && player.isOperator) setOperator(true);
            }
          }
          return [...next.values()];
        });
      }
      if (event.type === "chat" && event.accountId === accountId) {
        setMessages((current) => [...current, `CHAT|< ${event.source}: ${event.message}`]);
      }
      if (event.type === "command-response" && event.accountId === accountId) {
        setMessages((current) => [...current, `COMMAND|# ${event.message}`]);
      }
      if (event.type === "operator" && event.accountId === accountId) {
        setOperator(event.isOperator);
      }
      if (event.type === "session-log") {
        setConnectionLogs((current) => current.includes(event.message)
          ? current
          : [...current.slice(-20), event.message]);
      }
    });
    return unsubscribe;
  }, [accountId]);
  useEffect(() => {
    if (!joined) return;
    setPlayers([]);
    setOperator(false);
    setPlayerActionState({});
  }, [joined, accountId, worldId]);
  const visibleMessages = messages.filter((message) => logFilter === "all" || message.startsWith(`${logFilter === "chat" ? "CHAT" : "COMMAND"}|`));
  return (
    <section className="live-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">LIVE MODE / MANUAL CONTROL</p>
          <h2>ライブモード</h2>
          <p>アカウントを選び、ワールドへ参加して手動で操作します。</p>
        </div>
        <span className={`live-state ${joined ? "connected" : connecting ? "connecting" : "idle"}`}>
          {joined ? "参加中" : connecting ? "接続中" : "未接続"}
        </span>
      </div>
      {connecting && (
        <div className="connection-progress">
          <div className="progress-top">
            <b>{connectionStep}</b>
            <span>接続処理中</span>
          </div>
          <div className="progress-track">
            <i />
          </div>
          <small>認証・NetherNet・ワールド初期化の応答を待っています。</small>
        </div>
      )}
      {(connecting || joined) && <div className="connection-log"><b>接続ログ</b>{connectionLogs.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div>}
      {!joined && (
        <>
          <div className="live-world-toolbar">
            <div>
              <h3>ワールド一覧</h3>
              <p>検索して参加するワールドを選択してください。</p>
            </div>
            <label className="live-world-search">
              <span>⌕</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="ユーザー名またはワールド名で検索"
              />
            </label>
          </div>
          <div className="live-world-grid">
            {visibleWorlds.map((item, index) => (
              <button
                className={`live-world-card ${pendingWorldId === item.id ? "selected" : ""}`}
                key={item.id}
                onClick={() => {
                  setPendingWorldId(item.id);
                  setWorldModalOpen(true);
                }}
              >
                <div className={`live-world-cover cover-${index % 3}`}>
                  <span>{index % 2 ? "✦" : "⛰"}</span>
                  <em>{item.ownerGamertag}</em>
                </div>
                <div>
                  <h3>{item.name}</h3>
                  <p>
                    {item.players}/{item.maxPlayers ?? "?"} 人　·　
                    {item.version ?? "Bedrock"}
                  </p>
                  {pendingWorldId === item.id && <b>選択中</b>}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      {worldModalOpen && pendingWorldId && (
        <div
          className="modal-backdrop"
          onClick={() => setWorldModalOpen(false)}
        >
          <section
            className="live-join-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setWorldModalOpen(false)}
            >
              ×
            </button>
            <p className="eyebrow">WORLD JOIN</p>
            <h2>{worlds.find((item) => item.id === pendingWorldId)?.name}</h2>
            <p>参加に使用するアカウントを選択してください。</p>
            <div className="account-picker">
              <div className="account-picker-heading"><b>使用アカウント</b><span>{selectedAccounts.length}件選択中</span></div>
              <div className="account-picker-list">
                {accounts.map((account) => {
                  const checked = selectedAccounts.includes(account.id);
                  return <label className={`account-picker-row ${checked ? "selected" : ""}`} key={account.id}>
                    <input type="checkbox" checked={checked} onChange={() => setSelectedAccounts((current) => checked ? current.filter((id) => id !== account.id) : [...current, account.id])} />
                    <span className="picker-check">✓</span>
                    <span className="picker-avatar">{account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : account.gamertag.slice(0, 2).toUpperCase()}</span>
                    <span className="picker-account-name"><b>{account.gamertag}</b><small>{account.status === "online" ? "オンライン" : "オフライン"}</small></span>
                    <i className={`status ${account.status}`} />
                  </label>;
                })}
              </div>
              <p className="picker-help">行をクリックして複数アカウントを選択できます。</p>
            </div>
            <button
              className="primary-button"
              onClick={() => {
                const firstAccount = selectedAccounts[0];
                if (!firstAccount || !pendingWorldId) {
                  setConnectionStep("アカウントとワールドを選択してください");
                  return;
                }
                setWorldId(pendingWorldId);
                setAccountId(firstAccount);
                setConnecting(true);
                setConnectionLogs([]);
                setPlayers([]);
                setConnectionStep("NetherNet接続を開始しています…");
                setWorldModalOpen(false);
                void startLiveSession(selectedAccounts, pendingWorldId)
                  .then(() => {
                    setConnectionStep("ワールドへ参加しました");
                    setJoined(true);
                  })
                  .catch((error: unknown) => setConnectionStep(`接続に失敗しました: ${error instanceof Error ? error.message : String(error)}`))
                  .finally(() => setConnecting(false));
              }}
              disabled={!selectedAccounts.length}
            >
              GO　このワールドに参加
            </button>
          </section>
        </div>
      )}
      {joined && (
        <div className="live-workspace">
          <div className="terminal-panel">
            <div className="terminal-header">
              <span>●　{world?.name} <small>・{players.length}人 ・{operator ? "OP" : "プレイヤー"}</small></span>
              <button onClick={() => { void stopLiveSession(accountId); setJoined(false); }}>退出</button>
            </div>
            <div className="terminal-toolbar">
              <button className={logFilter === "all" ? "active" : ""} onClick={() => setLogFilter("all")}>すべて</button>
              <button className={logFilter === "chat" ? "active" : ""} onClick={() => setLogFilter("chat")}>チャット</button>
              <button className={logFilter === "command" ? "active" : ""} onClick={() => setLogFilter("command")}>コマンド</button>
            </div>
            <div className="terminal-output">
              {visibleMessages.length ? (
                visibleMessages.map((message, index) => <p key={index} className={message.startsWith("CHAT|") ? "chat-line" : "command-line"}>{message.replace(/^(CHAT|COMMAND)\|/, "")}</p>)
              ) : (
                <p className="terminal-muted">
                  チャットまたはコマンドを入力してください。
                </p>
              )}
            </div>
            <div className="terminal-input">
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") send();
                }}
                placeholder="チャット、または /help のようなコマンド"
              />
              <button
                className="terminal-send"
                onClick={send}
                aria-label="送信"
              >
                ›
              </button>
            </div>
          </div>
          <aside className="players-panel">
            <div className="players-heading">
              <h3>プレイヤー一覧</h3>
              <span>{players.length}</span>
            </div>
            {players.map((player) => (
              <div className="player-row" key={player.xuid}>
                <span className={`player-avatar ${player.isBot ? "bot" : ""}`}>
                  {player.gamertag.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <b>{player.gamertag}</b>
                  <small>
                    {player.isOwnBot || player.isBot
                      ? "自分のBot"
                      : player.isOperator
                        ? "OP"
                        : "プレイヤー"}
                  </small>
                </div>
                {!player.isOwnBot && !player.isBot && <button
                  className="player-action"
                  title="フレンド申請"
                  onClick={() => {
                    setPlayerActionState((current) => ({ ...current, [player.xuid]: "送信中…" }));
                    void addBackendFriend(accountId, player.xuid)
                      .then(() => setPlayerActionState((current) => ({ ...current, [player.xuid]: "申請済み" })))
                      .catch((error: unknown) => setPlayerActionState((current) => ({ ...current, [player.xuid]: error instanceof Error ? error.message : "失敗" })));
                  }}
                >＋</button>}
                {!player.isOwnBot && !player.isBot && <button
                  className="player-action player-kick-action"
                  title={operator ? "キック" : "通知"}
                  onClick={() => {
                    const target = player.gamertag.replaceAll('"', "");
                    // スペースを含むゲーマータグはBedrockのコマンドで
                    // 1つの対象名として扱うため引用符で囲む。
                    const quotedTarget = `"${target}"`;
                    const command = operator ? `/kick ${quotedTarget}` : `/tell ${quotedTarget} @a[name=a]`;
                    void sendLiveMessage(accountId, command, "command");
                  }}
                >{operator ? "キック" : "通知"}</button>}
                {playerActionState[player.xuid] && <small>{playerActionState[player.xuid]}</small>}
              </div>
            ))}
          </aside>
        </div>
      )}
    </section>
  );
}
