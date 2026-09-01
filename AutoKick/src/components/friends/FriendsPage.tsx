import { useEffect, useState } from "react";
import type { AccountProfile } from "../../client/types";
import {
  addFriend,
  listFriendRequestQueue,
  searchFriends,
  type FriendCandidate,
  type FriendRequestQueueItem,
} from "../../client/backendFriends";
import { backendSocket } from "../../client/backendService";

export function FriendsPage({ accounts }: { accounts: AccountProfile[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FriendCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [requestQueue, setRequestQueue] = useState<FriendRequestQueueItem[]>([]);
  const loadRequestQueue = async () => {
    try {
      setRequestQueue(await listFriendRequestQueue(backendSocket));
    } catch {
      // バックエンド起動直後などは申請履歴が取得できない場合がある。
    }
  };
  useEffect(() => { void loadRequestQueue(); }, []);
  const search = async () => {
    if (!accountId || !query.trim()) {
      setMessage("申請元アカウントと検索文字列を入力してください。");
      return;
    }
    setBusy(true);
    setMessage("");
    setResults([]);
    try {
      const found = await searchFriends(backendSocket, accountId, query.trim());
      setResults(found);
      if (!found.length)
        setMessage(
           "ユーザーが見つかりませんでした。Gamertagの綴り・大文字小文字、または16桁のXUIDを確認してください。",
        );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="friends-page">
      <div className="section-heading">
        <div>
          <p className="eyebrow">SOCIAL / FRIENDS</p>
          <h2>フレンド</h2>
          <p>GamertagまたはXUIDで検索してフレンド申請を送信できます。</p>
        </div>
      </div>
      <div className="friends-search">
        <label>
          申請元アカウント
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {accounts.map((account) => (
              <option value={account.id} key={account.id}>
                {account.gamertag}
              </option>
            ))}
          </select>
        </label>
        <label className="friend-query">
          ユーザー名またはフレンドID
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
            placeholder="Gamertag / XUID"
          />
        </label>
        <button
          className="primary-button"
          onClick={() => void search()}
          disabled={busy}
        >
          {busy ? "検索中…" : "検索"}
        </button>
      </div>
      {message && <p className="friend-error">{message}</p>}
      <div className="friend-results">
        {results.map((person) => (
          <article className="friend-result" key={person.xuid}>
            <span className="profile-avatar">
              {person.avatarUrl ? (
                <img src={person.avatarUrl} alt="" />
              ) : (
                person.gamertag.slice(0, 2).toUpperCase()
              )}
            </span>
            <div>
              <h3>{person.gamertag}</h3>
              <p>XUID {person.xuid}</p>
            </div>
            <button
              className="details-button"
              onClick={() =>
                void addFriend(backendSocket, accountId, person.xuid)
                  .then(async () => {
                    setMessage(`${person.gamertag} へフレンド申請を送信しました。`);
                    await loadRequestQueue();
                  })
                  .catch((error) =>
                    setMessage(
                      error instanceof Error ? error.message : String(error),
                    ),
                  )
              }
            >
              フレンド申請
            </button>
          </article>
        ))}
      </div>
      <section className="friend-request-queue">
        <div className="section-heading">
          <div><p className="eyebrow">REQUEST MAPPING</p><h2>アカウント別フレンド申請</h2></div>
          <button className="details-button" onClick={() => void loadRequestQueue()}>更新</button>
        </div>
        {!requestQueue.length && <p>フレンド申請履歴はありません。</p>}
        {requestQueue.map((request) => (
          <article className="friend-result" key={request.xuid}>
            <div><h3>{request.gamertag}</h3><p>XUID {request.xuid}</p></div>
            <div>
              <strong>sent:</strong>
              {request.sent.length ? request.sent.map((sender) => <div key={sender.accountId}>{sender.gamertag} ({sender.accountId})</div>) : <div>なし</div>}
            </div>
            <div>
              <strong>pending:</strong>
              {request.pending.length ? request.pending.map((sender) => <div key={sender.accountId}>{sender.gamertag} ({sender.accountId})</div>) : <div>なし</div>}
            </div>
          </article>
        ))}
      </section>
    </section>
  );
}
