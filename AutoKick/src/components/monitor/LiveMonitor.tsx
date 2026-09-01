import type { ClientLog } from "../../client/types";

export function LiveMonitor({
  logs,
  running,
}: {
  logs: ClientLog[];
  running: boolean;
}) {
  return (
    <section className="panel monitor">
      <div className="panel-title">
        <div>
          <p className="eyebrow">LIVE MONITOR</p>
          <h3>実行ログ</h3>
        </div>
        <span className="live">
          <i />
          {running ? "RUNNING" : "READY"}
        </span>
      </div>
      <div className="log">
        {logs.length ? (
          logs.map((log, index) => (
            <div key={`${log.timestamp}-${index}`}>
              <time>{new Date(log.timestamp).toLocaleTimeString("ja-JP")}</time>
              <span className="log-dot" />
              <p>{log.message}</p>
            </div>
          ))
        ) : (
          <div>
            <p>ログはまだありません。</p>
          </div>
        )}
      </div>
    </section>
  );
}
