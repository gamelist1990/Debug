import { useState } from "react";
import type { AccountJoinMode, AccountProfile } from "../../client/types";
import { beginBackendLogin, listBackendAccounts } from "../../client/backendService";

interface Props {
  accounts: AccountProfile[];
  selected: string[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => Promise<void>;
  onAdded: (accounts: AccountProfile[]) => void;
  joinMode: AccountJoinMode;
  onJoinModeChange: (mode: AccountJoinMode) => void;
}
export function AccountPage({ accounts, selected, onToggle, onRemove, onAdded, joinMode, onJoinModeChange }: Props) {
  const [detailId, setDetailId] = useState<string>();
  const detail = accounts.find((account) => account.id === detailId);
  const [login, setLogin] = useState<{ verificationUri: string; userCode: string }>();
  return (
    <section className="account-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ACCOUNT MANAGEMENT</p>
          <h2>アカウント</h2>
          <p>接続に使用するXboxアカウントを管理します。</p>
        </div>
        <button className="primary-button" onClick={() => void beginBackendLogin().then(setLogin).catch((error) => window.alert(error instanceof Error ? error.message : String(error)))}>＋アカウントを追加</button>
      </div>
      <div className="account-grid">
        {accounts.map((account) => (
          <article className="account-card" key={account.id}>
            <div className="profile-row">
              <div className="profile-avatar">
                {account.avatarUrl ? (
                  <img src={account.avatarUrl} alt="" />
                ) : (
                  account.gamertag.slice(0, 2).toUpperCase()
                )}
              </div>
              <div>
                <h3>{account.gamertag}</h3>
                <p>{account.xuid ? `XUID ${account.xuid}` : "XUID 未取得"}</p>
              </div>
              <span className={`account-state ${account.status}`} />{" "}
            </div>
              <label className="account-use account-use-switch">
              <input
                type="checkbox"
                checked={selected.includes(account.id)}
                onChange={() => onToggle(account.id)}
              />
              <span />
                <b>{selected.includes(account.id) ? "使用する" : "使用しない"}</b>
            </label>
            <div className="account-actions"><button className="account-action" onClick={() => setDetailId(account.id)}>詳細と統計</button><button className="logout-button" onClick={() => void onRemove(account.id)}>ログアウト</button></div>
          </article>
        ))}
      </div>
      <section className="join-mode-settings" aria-labelledby="join-mode-title">
        <div className="join-mode-heading"><h3 id="join-mode-title">ワールド参加方式</h3><p>選択したアカウントの参加方法</p></div>
        <div className="join-mode-options">
          <label className={joinMode === "single-world-all" ? "selected" : ""}><input type="radio" checked={joinMode === "single-world-all"} onChange={() => onJoinModeChange("single-world-all")} /><span><b>全員で参加</b><small>1つのワールドに選択済みアカウント全員</small></span></label>
          <label className={joinMode === "one-account-per-world" ? "selected" : ""}><input type="radio" checked={joinMode === "one-account-per-world"} onChange={() => onJoinModeChange("one-account-per-world")} /><span><b>分散して参加</b><small>ワールドごとに1アカウントずつ</small></span></label>
        </div>
      </section>
      {login && <div className="modal-backdrop" onClick={() => setLogin(undefined)}><section className="account-detail-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setLogin(undefined)}>×</button><p className="eyebrow">MICROSOFT LOGIN</p><h2>アカウントを追加</h2><p>表示されたURLを開き、次のコードを入力してください。</p><a className="login-link" href={login.verificationUri} target="_blank" rel="noreferrer">Microsoft認証ページを開く</a><div className="device-code">{login.userCode}</div><p className="modal-note">認証完了後、ここを閉じるとアカウント一覧を更新します。</p><button className="primary-button" onClick={() => void listBackendAccounts().then((items) => { onAdded(items); setLogin(undefined); })}>認証完了・一覧を更新</button></section></div>}{detail && <div className="modal-backdrop" onClick={() => setDetailId(undefined)}><section className="account-detail-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setDetailId(undefined)}>×</button><div className="detail-identity"><div className="profile-avatar large">{detail.avatarUrl ? <img src={detail.avatarUrl} alt="" /> : detail.gamertag.slice(0, 2).toUpperCase()}</div><div><p className="eyebrow">ACCOUNT DETAILS</p><h2>{detail.gamertag}</h2><p>{detail.xuid ? `XUID ${detail.xuid}` : "XUID 未取得"}</p></div></div><div className="stats-grid"><div><strong>{detail.loggedInAt ? new Date(detail.loggedInAt).toLocaleDateString("ja-JP") : "未取得"}</strong><span>初回ログイン</span></div><div><strong>{typeof detail.worldJoinCount === "number" ? detail.worldJoinCount : "未取得"}</strong><span>ワールド参加回数</span></div><div><strong>{typeof detail.friendCount === "number" ? detail.friendCount : "未取得"}</strong><span>フレンド数</span></div></div><button className="danger-button" onClick={() => { onRemove(detail.id); setDetailId(undefined); }}>このアカウントをログアウト</button></section></div>}
    </section>
  );
}
