import { useState } from "react";
import type { AccountProfile, WorldSession } from "../../client/types";

interface Props {
  worlds: WorldSession[];
  selectedId: string;
  joiningId?: string;
  loading?: boolean;
  onRefresh?: () => void;
  onSelect: (id: string) => void;
  onJoin: (id: string, accountIds?: string[]) => void;
  joinMode?: "single-world-all" | "one-account-per-world";
  accounts?: AccountProfile[];
  selectedAccountIds?: string[];
  autoRunning?: boolean;
  onAutoStart?: () => void;
}
export function WorldSelector({
  worlds,
  selectedId,
  joiningId,
  loading = false,
  onRefresh,
  onSelect,
  onJoin,
  joinMode = "single-world-all",
  accounts = [],
  selectedAccountIds = [],
  autoRunning = false,
  onAutoStart,
}: Props) {
  const [accountModalWorld, setAccountModalWorld] = useState<WorldSession>();
  const [accountChoices, setAccountChoices] = useState<string[]>([]);
  return (
    <section className="world-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">FRIEND WORLDS</p>
          <h2>参加可能なワールド</h2>
          <p>カードを選択して詳細を確認し、参加してください。</p>
        </div>
        <button className="outline-button" onClick={onRefresh} disabled={loading}>
          ↻　再スキャン
        </button>
        {onAutoStart && <button type="button" className="primary-button" onClick={() => void onAutoStart()} disabled={autoRunning}>
          {autoRunning ? "自動モード実行中…" : "自動モードを開始　→"}
        </button>}
      </div>
      {autoRunning && (
        <div className="auto-mode-running" role="status" aria-live="polite">
          <span className="auto-mode-running-icon"><span className="loading-spinner" /></span>
          <div className="auto-mode-running-copy">
            <strong>自動モードが動作中です</strong>
            <p>対象ワールドを順番に確認し、接続できたワールドでアクションを実行しています。</p>
          </div>
          <div className="auto-mode-running-meta">
            <b>{selectedAccountIds.length} アカウント</b>
            <span>並列処理中</span>
          </div>
        </div>
      )}
      {loading && worlds.length === 0 ? (
        <div className="loading-state" role="status" aria-live="polite">
          <span className="loading-spinner" />
          <div><b>参加可能なワールドを取得中です</b><small>見つかったワールドから順番に表示します…</small></div>
        </div>
      ) : worlds.length === 0 ? (
        <div className="empty-state"><b>参加可能なワールドがありません</b><small>再スキャンして最新の情報を取得してください。</small></div>
      ) : <div className="world-grid">
        {worlds.map((world, index) => {
          const joining = joiningId === world.id;
          return (
            <article
              className={`world-card ${world.id === selectedId ? "selected" : ""} ${joining ? "joining" : ""}`}
              key={world.id}
              onClick={() => !joining && onSelect(world.id)}
            >
              <div className={`world-cover cover-${index % 3}`}>
                <span>{index === 0 ? "⛰" : index === 1 ? "✦" : "◈"}</span>
                <em>
                  {world.source === "friend"
                    ? "フレンド"
                    : "フレンドのフレンド"}
                </em>
              </div>
              <div className="world-card-body">
                <div className="world-card-title">
                  <div>
                    <h3>{world.name}</h3>
                    <p>{world.ownerGamertag}</p>
                  </div>
                  <span className="card-arrow">↗</span>
                </div>
                <div className="world-card-footer">
                  <span>
                    ●　{world.players}/{world.maxPlayers ?? "?"} 人
                  </span>
                  <span>{world.version ?? "Bedrock"}</span>
                </div>
                <small className="world-availability">参加可能: {world.availableAccountIds?.length ? world.availableAccountIds.length + "アカウント" : "確認中"}</small>
                {world.id === selectedId && (
                  <>
                    <div className="selected-label">
                      {joining ? "参加処理中…" : "選択中"}
                    </div>
                    <button
                      className="join-world"
                      disabled={joining}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (joinMode === "one-account-per-world") {
                          const available = accounts.filter((account) =>
                            !world.availableAccountIds?.length || world.availableAccountIds.includes(account.id),
                          );
                          const defaults = selectedAccountIds.filter((id) => available.some((account) => account.id === id));
                          const defaultAccountId = defaults[0] ?? available[0]?.id;
                          setAccountChoices(defaultAccountId ? [defaultAccountId] : []);
                          setAccountModalWorld(world);
                        } else {
                          onJoin(world.id);
                        }
                      }}
                    >
                      {joining ? (
                        <>
                          <span className="join-spinner" />
                          参加処理中…
                        </>
                      ) : (
                        "このワールドに参加　→"
                      )}
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>}
      {accountModalWorld && (
        <div className="modal-backdrop" onClick={() => setAccountModalWorld(undefined)}>
          <section className="account-detail-modal join-account-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setAccountModalWorld(undefined)}>×</button>
            <div className="join-modal-heading"><span className="join-modal-icon">↗</span><div><p className="eyebrow">DISTRIBUTED JOIN</p><h2>参加アカウントを選択</h2></div></div>
            <div className="join-target-card"><span className="target-world-icon">◈</span><div><small>参加先ワールド</small><b>{accountModalWorld.name}</b><span>ホスト: {accountModalWorld.ownerGamertag}</span></div></div>
            <p className="join-modal-description">このワールドに接続するアカウントを1つ選択してください。</p>
            <div className="join-account-list">
              {accounts.filter((account) => !accountModalWorld.availableAccountIds?.length || accountModalWorld.availableAccountIds.includes(account.id)).map((account) => (
                <label className={`join-account-option ${accountChoices[0] === account.id ? "selected" : ""}`} key={account.id}>
                  <input type="radio" name="distributed-join-account" checked={accountChoices[0] === account.id} onChange={() => setAccountChoices([account.id])} />
                  <span className="join-account-check">✓</span><span className="join-account-avatar">{account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : account.gamertag.slice(0, 2).toUpperCase()}</span><span className="join-account-text"><b>{account.gamertag}</b><small><i className={`status ${account.status}`} />{account.status === "online" ? "オンライン" : "オフライン"}　·　{account.id}</small></span><span className="join-account-arrow">›</span>
                </label>
              ))}
            </div>
            <div className="join-modal-footer"><small>選択したアカウントのみがこのワールドへ参加します。</small><button className="primary-button" disabled={!accountChoices.length} onClick={() => { onJoin(accountModalWorld.id, accountChoices); setAccountModalWorld(undefined); }}>このアカウントで参加　→</button></div>
          </section>
        </div>
      )}
    </section>
  );
}
