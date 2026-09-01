import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountProfile,
  AutomationOptions,
  AccountAutomationMap,
  ClientLog,
  WorldSession,
  AccountJoinMode,
} from "../client/types";
import { tokenStore } from "./services";
import { AppShell } from "../components/layout/AppShell";
import { AccountPage } from "../components/accounts/AccountPage";
import { WorldSelector } from "../components/worlds/WorldSelector";
import { AccountAutomationSettings } from "../components/automation/AccountAutomationSettings";
import { SettingsPage } from "../components/settings/SettingsPage";
import { LiveMonitor } from "../components/monitor/LiveMonitor";
import { SessionHistory } from "../components/history/SessionHistory";
import { backendSocket, startNodeBackend, listBackendAccounts, listBackendWorlds, listBackendPlugins, loadBackendConfig, saveBackendConfig, removeBackendAccount } from "../client/backendService";
import type { BackendEvent } from "../backend/protocol";
import { LiveMode } from "../components/live/LiveMode";
import { FriendsPage } from "../components/friends/FriendsPage";
import { stopBackendSession } from "../client/backendService";

type SavedExternalServer = { id: string; name: string; host: string; port: number };

const initialOptions: AutomationOptions = {
  kind: "chat",
  message: "Hello from AutoKick!",
  count: 5,
  intervalTicks: 1,
  sendFriendRequests: true,
  autoFriendRequestPlayers: true,
  autoExit: true,
  intervalMs: 50,
  executionMode: "parallel",
  steps: [{ kind: "chat", message: "Hello from AutoKick!", count: 5, intervalTicks: 1 }],
  detectOperator: true,
  operatorBehavior: "continue",
  autoAcceptFriendRequests: false,
  autoKickEnabled: false,
  autoKickCommand: '/tell "{random}" @a[name=a]',
  autoKickHostOnly: false,
  placeholderHelp: true,
};
export function App() {
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [worlds, setWorlds] = useState<WorldSession[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [joinMode, setJoinMode] = useState<AccountJoinMode>("single-world-all");
  const [worldId, setWorldId] = useState("");
  const [joiningWorldId, setJoiningWorldId] = useState<string>();
  const [autoRunning, setAutoRunning] = useState(false);
  const [botStatuses, setBotStatuses] = useState<Record<string, { name: string; state: string; detail: string }>>({});
  const [accountOptions, setAccountOptions] = useState<AccountAutomationMap>({});
  const [logs, setLogs] = useState<ClientLog[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendLoading, setBackendLoading] = useState(true);
  const [worldsLoading, setWorldsLoading] = useState(false);
  const worldLoadGeneration = useRef(0);
  const worldLoadInFlight = useRef(false);
  const [lastSync, setLastSync] = useState<string>();
  const [search, setSearch] = useState("");
  const [externalHost, setExternalHost] = useState("");
  const [externalPort, setExternalPort] = useState("19132");
  const [externalAccountIds, setExternalAccountIds] = useState<string[]>([]);
  const [externalConnecting, setExternalConnecting] = useState(false);
  const [externalServers, setExternalServers] = useState<SavedExternalServer[]>([]);
  const [externalServerName, setExternalServerName] = useState("");
  const savedConfigRef = useRef<Record<string, unknown>>({});
  const [plugins, setPlugins] = useState<Array<{ id: string; name: string; version?: string; actions: string[] }>>([]);
  const [page, setPage] = useState(
    window.location.hash === "#accounts"
      ? "accounts"
      : window.location.hash === "#history"
        ? "history"
        : window.location.hash === "#settings"
          ? "settings"
          : window.location.hash === "#live"
            ? "live"
            : window.location.hash === "#external"
              ? "external"
        : "dashboard",
  );
  useEffect(() => {
    setBackendLoading(true);
    void startNodeBackend().then(async () => {
      const [items, savedConfig] = await Promise.all([listBackendAccounts(), loadBackendConfig()]);
      savedConfigRef.current = savedConfig;
      setBackendConnected(true);
      setLastSync(new Date().toLocaleTimeString("ja-JP"));
      setAccounts(items);
      setBackendLoading(false);
      const savedOptions = savedConfig.accountOptions && typeof savedConfig.accountOptions === "object" ? savedConfig.accountOptions as AccountAutomationMap : {};
      setAccountOptions(Object.fromEntries(items.map((account) => {
        const saved = savedOptions[account.id];
        return [account.id, {
          ...initialOptions,
          ...(saved ?? {}),
          autoKickCommand: typeof saved?.autoKickCommand === "string" && saved.autoKickCommand.trim()
            ? saved.autoKickCommand
            : initialOptions.autoKickCommand,
        }];
      })));
      if (savedConfig.joinMode === "single-world-all" || savedConfig.joinMode === "one-account-per-world") {
        setJoinMode(savedConfig.joinMode);
      }
      const savedSelected = Array.isArray(savedConfig.selectedAccountIds)
        ? savedConfig.selectedAccountIds.filter((id): id is string => typeof id === "string" && items.some((account) => account.id === id))
        : [];
      setSelected(savedSelected.length ? savedSelected : items.slice(0, 2).map((item) => item.id));
      const savedServers = Array.isArray(savedConfig.externalServers)
        ? savedConfig.externalServers
        : Array.isArray((savedConfig as any).savedServers)
          ? (savedConfig as any).savedServers
          : [];
      setExternalServers((savedServers as unknown[]).filter((server): server is SavedExternalServer =>
        Boolean(server && typeof server === "object" && typeof (server as any).id === "string" && typeof (server as any).name === "string" && typeof (server as any).host === "string" && Number.isInteger((server as any).port)),
      ));
      void listBackendPlugins().then(setPlugins).catch(() => setPlugins([]));
      if (items.length)
        void loadWorlds(items.map((item) => item.id));
    }).catch(() => { setBackendConnected(false); setBackendLoading(false); });
    const unsubscribeSocket = backendSocket.on((event: BackendEvent) => {
      if (event.type === "ready") { setBackendConnected(true); setLastSync(new Date().toLocaleTimeString("ja-JP")); }
      if (event.type === "session-log") {
        setLogs((current) => [
          ...current.slice(-30),
          {
            timestamp: event.timestamp,
            level: event.level,
            message: event.message,
          },
        ]);
      }
      if (event.type === "session-state" && (event.state === "stopped" || event.state === "error")) {
        // start-external-sessionの応答(pong)は開始受付の完了であり、
        // 実際の接続処理はバックエンドで継続する。セッション終了通知を
        // 受け取った時点で外部サーバーのボタンを再利用可能に戻す。
        setExternalConnecting(false);
        setJoiningWorldId(undefined);
        setAutoRunning(false);
        if (event.state === "error" && event.message) {
          setLogs((current) => [...current, { timestamp: new Date().toISOString(), level: "error", message: event.message! }]);
        }
      }
      if (event.type === "session-log") {
        const match = event.message.match(/^([^:：]+)[:：]\s*(.+)$/);
        if (match) {
          const name = match[1]?.trim();
          const detail = match[2]?.trim();
          if (!name || !detail) return;
          const state = detail.includes("退出") || detail.includes("切断")
            ? "退出"
            : detail.includes("参加しました")
              ? "参加中"
              : detail.includes("失敗") || detail.includes("エラー")
                ? "エラー"
                : detail.includes("接続") || detail.includes("準備") || detail.includes("更新")
                  ? "接続処理中"
                  : "動作中";
          setBotStatuses((current) => ({ ...current, [name]: { name, state, detail } }));
        }
      }
    });
    return () => unsubscribeSocket();
  }, []);
  const loadWorlds = async (accountIds: string[]) => {
    // Session Directoryの取得が10秒を超える場合でも、自動更新を重ねない。
    // 以前は10秒間隔の新しい検索が進行中検索を世代切れにし続け、
    // worldsLoadingが解除されない状態になることがあった。
    if (worldLoadInFlight.current) return;
    worldLoadInFlight.current = true;
    const generation = ++worldLoadGeneration.current;
    setWorldsLoading(true);
    const merged = new Map<string, WorldSession>();
    let firstError: unknown;
    let succeeded = 0;
    const mergeWorlds = (found: WorldSession[]) => {
      for (const world of found) {
        const current = merged.get(world.id);
        merged.set(world.id, current ? {
          ...current,
          ...world,
          source: current.source === "friend" || world.source === "friend" ? "friend" : "friend-of-friend",
          availableAccountIds: [...new Set([...(current.availableAccountIds ?? []), ...(world.availableAccountIds ?? [])])],
        } : {
          ...world,
          availableAccountIds: [...new Set(world.availableAccountIds ?? [])],
        });
      }
      if (generation !== worldLoadGeneration.current) return;
      // 更新途中は前回の一覧を保持し、全アカウントの取得が終わった時点で
      // 完成した新しい一覧へ置き換える。これにより古いワールドを次回更新時
      // に必ず削除でき、取得途中の一時的な空結果でカードがちらつくことも防ぐ。
    };
    try {
      await Promise.all(accountIds.map(async (accountId) => {
        try {
          const found = await listBackendWorlds(accountId);
          succeeded += 1;
          mergeWorlds(found);
        } catch (error) {
          firstError ??= error;
        }
      }));
      if (generation !== worldLoadGeneration.current) return;
      if (succeeded === 0 && firstError) {
        setLogs((current) => [...current, { timestamp: new Date().toISOString(), level: "warning", message: `ワールド取得失敗: ${firstError instanceof Error ? firstError.message : String(firstError)}` }]);
      } else if (succeeded > 0) {
        const completed = [...merged.values()];
        setWorlds(completed);
        setWorldId((current) => completed.some((world) => world.id === current) ? current : completed[0]?.id ?? "");
      }
    } finally {
      if (generation === worldLoadGeneration.current) setWorldsLoading(false);
      worldLoadInFlight.current = false;
    }
  };
  useEffect(() => {
    const accountIds = accounts.map((account) => account.id);
    if (!accountIds.length) return;
    const refreshWorlds = () => {
      void loadWorlds(accountIds);
    };
    const timer = setInterval(refreshWorlds, 10_000);
    return () => clearInterval(timer);
  }, [accounts]);
  useEffect(() => {
    const onHashChange = () =>
      setPage(
        window.location.hash === "#accounts"
          ? "accounts"
      : window.location.hash === "#friends"
        ? "friends"
          : window.location.hash === "#friends"
            ? "friends"
          : window.location.hash === "#history"
            ? "history"
            : window.location.hash === "#settings"
              ? "settings"
              : window.location.hash === "#live"
                ? "live"
                : window.location.hash === "#external"
                  ? "external"
            : "dashboard",
      );
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const chosenWorld = useMemo(
    () => worlds.find((world) => world.id === worldId),
    [worlds, worldId],
  );
  const visibleWorlds = useMemo(() => { const query = search.trim().toLocaleLowerCase(); if (!query) return worlds; const exact = worlds.filter((world) => world.ownerGamertag.toLocaleLowerCase() === query); if (exact.length) return exact; return worlds.filter((world) => `${world.name} ${world.ownerGamertag}`.toLocaleLowerCase().includes(query)); }, [search, worlds]);
  const accountVisibleWorlds = useMemo(() => visibleWorlds.filter((world) => !selected.length || !world.availableAccountIds || world.availableAccountIds.some((id) => selected.includes(id))), [selected, visibleWorlds]);
  const run = (targetWorldId: string, selectedForWorld?: string[]) => {
    if (!selected.length) return;
    setJoiningWorldId(targetWorldId);
    const assignments = joinMode === "one-account-per-world"
      ? (() => {
          // モーダルで明示した1アカウントだけを、押下したワールドへ割り当てる。
          // 他のワールドまで同時に開始すると、Session Directoryのnonce登録が
          // 競合し、別アカウントのnonceが返ることがある。
          const accountId = selectedForWorld?.[0] ?? selected[0];
          return accountId ? [{ worldId: targetWorldId, accountIds: [accountId] }] : [];
        })()
      : [{ worldId: targetWorldId, accountIds: selected }];
    const sessionAccountIds = [...new Set(assignments.flatMap((assignment) => assignment.accountIds))];
    try {
      backendSocket.send({ type: "start-session", requestId: crypto.randomUUID(), accountIds: sessionAccountIds, worldId: targetWorldId, options: accountOptions, joinMode, assignments });
    } catch (error) {
      setLogs((current) => [...current, { timestamp: new Date().toISOString(), level: "error", message: error instanceof Error ? error.message : String(error) }]);
      setJoiningWorldId(undefined);
    }
  };
  const runAuto = async () => {
    if (autoRunning) return;
    if (!selected.length) {
      setLogs((current) => [...current, { timestamp: new Date().toISOString(), level: "warning", message: "自動モードを開始するアカウントを選択してください。" }]);
      return;
    }
    const eligible = accountVisibleWorlds.filter((world) => /^[A-Za-z0-9 ]+$/.test(world.ownerGamertag.trim()));
    setAutoRunning(true);
    setJoiningWorldId("auto");
    setBotStatuses(Object.fromEntries(selected.map((accountId) => {
      const account = accounts.find((item) => item.id === accountId);
      return [account?.gamertag ?? accountId, { name: account?.gamertag ?? accountId, state: "開始中", detail: "自動モードの対象を選択しています…" }];
    })));
    try {
      if (!backendSocket.isConnected()) await startNodeBackend();
      const requestId = crypto.randomUUID();
      // 対象判定はバックエンド側でも行う。UI側で先に絞ると、表示名に
      // 不可視文字などが含まれるワールドを誤って全件除外することがある。
      await backendSocket.request({ type: "start-auto-session", requestId, accountIds: selected, worlds: accountVisibleWorlds.map(({ id, ownerGamertag, availableAccountIds }) => ({ id, ownerGamertag, accountIds: availableAccountIds })), options: accountOptions }, requestId);
    } catch (error) {
      setAutoRunning(false);
      setJoiningWorldId(undefined);
      setLogs((current) => [...current, { timestamp: new Date().toISOString(), level: "error", message: error instanceof Error ? error.message : String(error) }]);
    }
  };
  const runExternal = async () => {
    const host = externalHost.trim();
    const port = Number(externalPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !externalAccountIds.length) {
      setLogs((current) => [...current, { timestamp: new Date().toISOString(), level: "warning", message: "外部サーバーのアドレス・ポート・アカウントを確認してください。" }]);
      return;
    }
    setExternalConnecting(true);
    setJoiningWorldId(`external:${host}:${port}`);
    setBotStatuses(Object.fromEntries(externalAccountIds.map((accountId) => {
      const account = accounts.find((item) => item.id === accountId);
      return [account?.gamertag ?? accountId, { name: account?.gamertag ?? accountId, state: "開始中", detail: "外部サーバーへの接続処理を開始しています…" }];
    })));
    try {
      const requestId = crypto.randomUUID();
      await backendSocket.request({ type: "start-external-session", requestId, host, port, accountIds: externalAccountIds, options: accountOptions }, requestId);
      // requestの成功は接続開始の受付完了を意味する。終了時の
      // session-state(stopped/error)でfalseへ戻すため、ここではtrueを維持する。
    } catch (error) {
      setExternalConnecting(false);
      setJoiningWorldId(undefined);
      setLogs((current) => [...current, { timestamp: new Date().toISOString(), level: "error", message: error instanceof Error ? error.message : String(error) }]);
    }
  };
  const persistExternalServers = async (next: SavedExternalServer[]) => {
    const nextConfig = { ...savedConfigRef.current, externalServers: next, savedServers: next };
    savedConfigRef.current = nextConfig;
    setExternalServers(next);
    await saveBackendConfig(nextConfig);
  };
  const selectExternalServer = (server: SavedExternalServer) => {
    setExternalHost(server.host);
    setExternalPort(String(server.port));
    setExternalServerName(server.name);
  };
  return (
    <AppShell backendConnected={backendConnected} lastSync={lastSync}>
      <header className="page-header">
        <div>
          <p className="eyebrow">
            AUTOKICK / {page.toUpperCase()}
          </p>
          <h1>
            {page === "accounts"
              ? "アカウント管理"
              : page === "friends"
                ? "フレンド"
              : page === "history"
                ? "セッション履歴"
                : page === "settings"
                  ? "設定"
                    : page === "live"
                      ? "ライブモード"
                      : page === "external"
                        ? "外部サーバー"
                : "ワールドダッシュボード"}
          </h1>
        </div>
        <div className="header-actions">
          <span className="sync">● 最終同期 {lastSync ?? "未接続"}</span>
          <div className="help-wrap"><button className="icon-btn" onClick={() => setHelpOpen((open) => !open)} aria-label="AutoKickの説明">?</button>{helpOpen && <div className="help-popover"><b>AutoKickについて</b><p>フレンドのワールドへ参加し、アカウントごとに設定したアクションを実行できます。</p><small>カードの参加ボタンからセッションを開始します。</small></div>}</div>
          <div className="profile-menu"><button className="avatar-image" aria-label="ログイン済みアカウント">{accounts[0]?.avatarUrl ? <img src={accounts[0].avatarUrl} alt={accounts[0].gamertag} /> : accounts[0]?.gamertag.slice(0, 2).toUpperCase() ?? "--"}</button><div className="profile-popover"><div className="profile-popover-heading">ログイン済みアカウント <span>{accounts.length}</span></div>{accounts.map((account) => <div className="profile-account" key={account.id}><span className="mini-avatar">{account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : account.gamertag.slice(0, 2).toUpperCase()}</span><div><b>{account.gamertag}</b><small>{account.status === "online" ? "オンライン" : "オフライン"}</small></div><i className={`status ${account.status}`} /></div>)}</div></div>
        </div>
      </header>
      {page === "accounts" ? (
        <AccountPage
          accounts={accounts}
          selected={selected}
          onToggle={(id) =>
            setSelected((current) => {
              const next = current.includes(id)
                ? current.filter((item) => item !== id)
                : [...current, id];
              void saveBackendConfig({ accountOptions, selectedAccountIds: next, joinMode });
              return next;
            })
          }
          onRemove={async (id) => { await removeBackendAccount(id); await tokenStore.remove(id); setAccounts((current) => current.filter((account) => account.id !== id)); setSelected((current) => current.filter((accountId) => accountId !== id)); }}
          onAdded={(items) => { setAccounts(items); setSelected((current) => current.filter((id) => items.some((item) => item.id === id))); }}
          joinMode={joinMode}
          onJoinModeChange={(mode) => { setJoinMode(mode); void saveBackendConfig({ accountOptions, selectedAccountIds: selected, joinMode: mode }); }}
        />
      ) : page === "friends" ? (
        <FriendsPage accounts={accounts} />
      ) : page === "history" ? (
        <SessionHistory logs={logs} />
      ) : page === "settings" ? (
        <SettingsPage accounts={accounts} values={accountOptions} plugins={plugins} onChange={(id, value) => { const next = { ...accountOptions, [id]: value }; setAccountOptions(next); void saveBackendConfig({ accountOptions: next, selectedAccountIds: selected, joinMode }); }} onReset={(id) => { const next = { ...accountOptions, [id]: initialOptions }; setAccountOptions(next); void saveBackendConfig({ accountOptions: next, selectedAccountIds: selected, joinMode }); }} />
      ) : page === "live" ? (
        <LiveMode accounts={accounts} worlds={worlds} />
      ) : page === "external" ? (
        <section className="external-server-page">
          <div className="external-hero"><div><p className="eyebrow">SERVER HUB</p><h2>外部サーバーに参加</h2><p>よく使うBedrockサーバーを保存して、次回からすぐに接続できます。</p></div><div className="external-hero-mark">↗</div></div>
          <div className="external-layout">
            <aside className="saved-server-panel"><div className="external-panel-heading"><div><span className="eyebrow">SAVED SERVERS</span><h3>保存済みサーバー</h3></div><span className="server-count">{externalServers.length}</span></div>{externalServers.length ? <div className="saved-server-list">{externalServers.map((server) => <div className={`saved-server-row ${externalHost === server.host && externalPort === String(server.port) ? "active" : ""}`} key={server.id} onClick={() => selectExternalServer(server)}><span className="server-icon">◈</span><span><b>{server.name}</b><small>{server.host}:{server.port}</small></span><button aria-label={`${server.name}を削除`} onClick={(event) => { event.stopPropagation(); void persistExternalServers(externalServers.filter((item) => item.id !== server.id)); }}>×</button></div>)}</div> : <div className="saved-server-empty"><span>＋</span><p>保存済みサーバーはありません。</p><small>右側のフォームから追加できます。</small></div>}</aside>
            <div className="external-connect-card"><div className="external-panel-heading"><div><span className="eyebrow">NEW CONNECTION</span><h3>接続先を設定</h3></div><span className="secure-badge">● 接続準備完了</span></div><div className="external-fields"><label className="field-wide"><span>表示名 <small>任意</small></span><input value={externalServerName} onChange={(event) => setExternalServerName(event.target.value)} placeholder="例: 友達のサーバー" /></label><label className="field-wide"><span>サーバーアドレス</span><input value={externalHost} onChange={(event) => setExternalHost(event.target.value)} placeholder="play.example.com" /></label><label><span>ポート</span><input type="number" min="1" max="65535" value={externalPort} onChange={(event) => setExternalPort(event.target.value)} /></label></div><div className="external-account-picker"><div className="external-picker-heading"><span>参加アカウント</span><small>{externalAccountIds.length}件選択中</small></div><div className="external-account-grid">{accounts.map((account) => <label className={`external-account-option ${externalAccountIds.includes(account.id) ? "selected" : ""}`} key={account.id}><input type="checkbox" checked={externalAccountIds.includes(account.id)} onChange={() => setExternalAccountIds((current) => current.includes(account.id) ? current.filter((id) => id !== account.id) : [...current, account.id])} /><span className="external-check">✓</span><span className="external-account-avatar">{account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : account.gamertag.slice(0, 2).toUpperCase()}</span><span><b>{account.gamertag}</b><small><i className={`status ${account.status}`} />{account.status === "online" ? "オンライン" : "オフライン"}</small></span></label>)}</div></div><div className="external-actions"><button className="outline-button" onClick={() => { const host = externalHost.trim(); const port = Number(externalPort); const name = externalServerName.trim() || host; if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return; const existing = externalServers.find((server) => server.host === host && server.port === port); const next = existing ? externalServers.map((server) => server.id === existing.id ? { ...server, name } : server) : [...externalServers, { id: crypto.randomUUID(), name, host, port }]; void persistExternalServers(next); }}>保存する</button><button className="primary-button" onClick={() => void runExternal()} disabled={externalConnecting}>{externalConnecting ? "接続処理中…" : "このサーバーに参加　→"}</button></div></div>
          </div>
          <section className="external-shell"><div className="external-shell-header"><div><span className="eyebrow">SESSION SHELL</span><h3>接続ログ</h3></div><span>{logs.length} lines</span></div><div className="external-shell-output" role="log" aria-live="polite">{logs.length ? logs.slice(-80).map((entry, index) => <div className={`shell-line ${entry.level}`} key={`${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString("ja-JP")}</time><span>{entry.message}</span></div>) : <div className="shell-empty">サーバーに接続すると、ここにログが表示されます。</div>}</div></section>
        </section>
      ) : (
        <>
      <section className="welcome-banner dashboard-intro">
        <div>
          <p className="eyebrow">AUTOMATION RUNNER</p>
          <h2>複数アカウントを、ひとつの操作で。</h2>
          <p>
            参加可能なワールドを選んで、すぐにセッションを開始できます。
          </p>
        </div>
        <div className="hero-stat">
          <strong>{selected.length}</strong>
          <span>選択中のアカウント</span>
        </div>
      </section>
      <div className="dashboard-toolbar"><div><p className="eyebrow">WORLD DIRECTORY</p><h2>ワールドを探す</h2></div><label className="dashboard-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ユーザー名またはワールド名で検索" /></label></div><div className="grid dashboard-grid">
        <WorldSelector
          worlds={accountVisibleWorlds}
          selectedId={worldId}
          joiningId={joiningWorldId}
          loading={worldsLoading || backendLoading}
          onRefresh={() => { if (accounts.length) void loadWorlds(accounts.map((account) => account.id)); }}
          onSelect={setWorldId}
          joinMode={joinMode}
          accounts={accounts}
          selectedAccountIds={selected}
          autoRunning={autoRunning}
          onAutoStart={runAuto}
          onJoin={(id, accountIds) => {
            setWorldId(id);
            setBotStatuses(Object.fromEntries(selected.map((accountId) => {
              const account = accounts.find((item) => item.id === accountId);
              return [account?.gamertag ?? accountId, { name: account?.gamertag ?? accountId, state: "開始中", detail: "接続処理を開始しています…" }];
            })));
            void run(id, accountIds);
          }}
        />
      </div>
      {Object.keys(botStatuses).length > 0 && <section className="bot-status-panel">
            <div className="section-heading"><div><p className="eyebrow">BOT SESSION STATUS</p><h2>Botの状態</h2><p>接続中のアカウントごとの現在の状態を表示しています。</p></div><div className="bot-status-actions"><span className={`live-state ${joiningWorldId ? "connecting" : "connected"}`}>{joiningWorldId ? "処理中" : "完了"}</span>{joiningWorldId && <button className="danger-button" onClick={() => void stopBackendSession().finally(() => { setJoiningWorldId(undefined); setAutoRunning(false); })}>途中で退出</button>}</div></div>
        <div className="bot-status-list">{Object.values(botStatuses).map((bot) => <div className="bot-status-row" key={bot.name}><span className={`bot-status-dot ${bot.state === "参加中" ? "online" : bot.state === "エラー" ? "error" : "busy"}`} /><div><b>{bot.name}</b><small>{bot.detail}</small></div><strong>{bot.state}</strong></div>)}</div>
      </section>}
        </>
      )}
    </AppShell>
  );
}
