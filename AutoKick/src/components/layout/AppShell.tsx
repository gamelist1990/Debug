import type { PropsWithChildren } from "react";

export function AppShell({ children, backendConnected = false, lastSync }: PropsWithChildren<{ backendConnected?: boolean; lastSync?: string }>) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <b>AutoKick</b>
            <small>CONTROL CENTER</small>
          </div>
        </div>
        <nav>
          <a className="nav active" href="#dashboard">
            ⌂　ダッシュボード
          </a>
          <a className="nav" href="#accounts">
            ◉　アカウント
          </a>
          <a className="nav" href="#friends">
            ♡　フレンド
          </a>
          <a className="nav" href="#history">
            ◈　セッション履歴
          </a>
          <a className="nav" href="#settings">
            ⚙　設定
          </a>
          <a className="nav" href="#live">
            ◉　ライブモード
          </a>
          <a className="nav" href="#external">
            ⇄　外部サーバー
          </a>
        </nav>
        <div className="side-footer">
          <span className="dot" />
          ローカルサービス <b className={backendConnected ? "service-online" : "service-offline"}>{backendConnected ? "ONLINE" : "OFFLINE"}</b>
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}
