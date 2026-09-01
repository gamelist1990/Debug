import { useState } from "react";
import type {
  AccountAutomationMap,
  AccountProfile,
  AutomationAction,
  AutomationOptions,
} from "../../client/types";

interface PluginInfo { id: string; name: string; version?: string; actions: string[] }

interface Props {
  accounts: AccountProfile[];
  values: AccountAutomationMap;
  onChange: (id: string, value: AutomationOptions) => void;
  plugins?: PluginInfo[];
  onReset: (id: string) => void;
}
export function AccountAutomationSettings({
  accounts,
  values,
  onChange,
  plugins = [],
  onReset,
}: Props) {
  const [detailId, setDetailId] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const detail = accounts.find((account) => account.id === detailId);
  const detailValue = detail ? values[detail.id] : undefined;

  return (
    <section className="automation-settings">
      <div className="section-heading">
        <div>
          <p className="eyebrow">ACCOUNT AUTOMATION</p>
          <h2>アクション設定</h2>
          <p>基本設定は一覧で、詳細な実行手順は詳細画面で設定します。</p>
        </div>
        <button
          className="details-button"
          onClick={() => setHelpOpen(true)}
        >
          プレースホルダーの説明
        </button>
      </div>
      <div className="settings-table-wrap">
        <table className="settings-table">
          <thead>
            <tr>
              <th>アカウント</th>
              <th>種類</th>
              <th>内容</th>
              <th>回数</th>
              <th>実行方式</th>
              <th>詳細</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const value = values[account.id];
              if (!value) return null;
              return (
                <tr key={account.id}>
                  <td>
                    <div className="table-account">
                      <span className="account-avatar">
                        {account.avatarUrl ? (
                          <img src={account.avatarUrl} alt="" />
                        ) : (
                          account.gamertag.slice(0, 2).toUpperCase()
                        )}
                      </span>
                      <b>{account.gamertag}</b>
                      <i className={`status ${account.status}`} />
                    </div>
                  </td>
                  <td>
                    <select
                      value={value.kind}
                      onChange={(event) =>
                        onChange(account.id, {
                          ...value,
                          kind: event.target.value as AutomationOptions["kind"],
                          steps: value.steps.map((step, index) => index === 0
                            ? { ...step, kind: event.target.value as AutomationAction["kind"] }
                            : step),
                        })
                      }
                    >
                      <option value="none">なし</option><option value="chat">チャット</option><option value="command">コマンド</option>
                    </select>
                  </td>
                  <td>
                    <input
                      value={value.message}
                      maxLength={512}
                      onBeforeInput={(event) => {
                        const inputEvent = event.nativeEvent as InputEvent;
                        if (inputEvent.data && Array.from(event.currentTarget.value + inputEvent.data).length > 512) event.preventDefault();
                      }}
                      onChange={(event) =>
                        onChange(account.id, {
                          ...value,
                          message: event.target.value.slice(0, 512),
                          steps: value.steps.map((step, index) => index === 0
                            ? { ...step, message: event.target.value.slice(0, 512) }
                            : step),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="count-input"
                      type="number"
                      min="-1"
                      max="9999"
                      placeholder="-1 = 無制限"
                      value={value.count}
                      onChange={(event) =>
                        onChange(account.id, {
                          ...value,
                          count: Number(event.target.value) === -1 ? -1 : Math.min(9999, Math.max(1, Number(event.target.value))),
                          steps: value.steps.map((step, index) => index === 0
                            ? { ...step, count: Number(event.target.value) === -1 ? -1 : Math.min(9999, Math.max(1, Number(event.target.value))) }
                            : step),
                        })
                      }
                    />
                  </td>
                  <td>
                    {value.executionMode === "parallel" ? "並列" : "直列"}
                  </td>
                  <td>
                    <button
                      className="details-button"
                      onClick={() => setDetailId(account.id)}
                    >
                      詳細を編集
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {detail && detailValue && (
        <AutomationDetailModal
          account={detail}
          value={detailValue}
          plugins={plugins}
          onChange={(value) => onChange(detail.id, value)}
          onReset={() => onReset(detail.id)}
          onClose={() => setDetailId(undefined)}
        />
      )}
      {helpOpen && <div className="modal-backdrop" onClick={() => setHelpOpen(false)}><section className="automation-modal placeholder-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setHelpOpen(false)}>×</button><p className="eyebrow">PLACEHOLDERS</p><h2>プレースホルダー一覧</h2><div className="placeholder-list"><p><code>{"{me}"}</code> 実行中の自分のGamertag</p><p><code>{"{random}"}</code> 現在のプレイヤーからランダムに1人</p><p><code>{"{host}"}</code> ワールドホスト</p><p><code>{"{time}"}</code> 現在時刻（HH:mm:ss）</p><p><code>{"{time.h}"}</code> 時、<code>{"{time.m}"}</code> 分、<code>{"{time.s}"}</code> 秒</p><p><code>{"{count}"}</code> 現在のプレイヤー人数</p></div></section></div>}
    </section>
  );
}

function AutomationDetailModal({
  account,
  value,
  plugins,
  onChange,
  onReset,
  onClose,
}: {
  account: AccountProfile;
  value: AutomationOptions;
  plugins: PluginInfo[];
  onChange: (value: AutomationOptions) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [placeholderOpen, setPlaceholderOpen] = useState(false);
  const update = (patch: Partial<AutomationOptions>) =>
    onChange({ ...value, ...patch });
  const updateStep = (index: number, patch: Partial<AutomationAction>) =>
    update({
      steps: value.steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step,
      ),
      ...(index === 0 && patch.count !== undefined ? { count: patch.count } : {}),
      ...(index === 0 && patch.message !== undefined ? { message: patch.message } : {}),
      ...(index === 0 && patch.kind !== undefined ? { kind: patch.kind } : {}),
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="automation-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose}>
          ×
        </button>
        <div className="detail-identity">
          <span className="account-avatar large">
            {account.avatarUrl ? (
              <img src={account.avatarUrl} alt="" />
            ) : (
              account.gamertag.slice(0, 2).toUpperCase()
            )}
          </span>
          <div>
            <p className="eyebrow">DETAILED AUTOMATION</p>
            <h2>{account.gamertag}</h2>
          </div>
        </div>
        <div className="modal-section">
          <h3>実行方式と間隔</h3>
          <div className="modal-grid">
            <label>
              実行方式
              <select
                value={value.executionMode}
                onChange={(event) =>
                  update({
                    executionMode: event.target
                      .value as AutomationOptions["executionMode"],
                  })
                }
              >
                <option value="parallel">並列</option>
                <option value="sequential">直列</option>
              </select>
            </label>
            <label>
              間隔（ミリ秒）
              <input
                type="number"
                min="0"
                value={value.intervalMs}
                onChange={(event) =>
                  update({
                    intervalMs: Math.max(0, Number(event.target.value)),
                  })
                }
              />
            </label>
          </div>
        </div>
        <div className="modal-section">
          <div className="modal-section-title">
            <h3>実行する一覧</h3>
            <div className="step-actions"><button className="details-button" onClick={() => setPlaceholderOpen(true)}>プレースホルダー</button><button className="details-button" onClick={() => update({ steps: [...value.steps, { kind: "chat", message: "", count: 1, intervalTicks: 1 }] })}>＋ 手順を追加</button></div>
          </div>
          {value.steps.map((step, index) => (
            <div className="step-row" key={`${index}-${step.kind}`}>
              <strong>{index + 1}</strong>
              <select
                value={step.kind}
                onChange={(event) =>
                  updateStep(index, {
                    kind: event.target.value as AutomationAction["kind"],
                  })
                }
              >
                <option value="none">なし</option>
                <option value="chat">チャット</option>
                <option value="command">コマンド</option>
                <option value="script">スクリプト</option>
              </select>
              {step.kind === "script" && <><select value={step.scriptId ?? ""} onChange={(event) => updateStep(index, { scriptId: event.target.value, scriptAction: plugins.find((plugin) => plugin.id === event.target.value)?.actions[0] ?? "" })}><option value="">スクリプトを選択</option>{plugins.map((plugin) => <option value={plugin.id} key={plugin.id}>{plugin.name}</option>)}</select><select value={step.scriptAction ?? ""} onChange={(event) => updateStep(index, { scriptAction: event.target.value })}><option value="">アクションを選択</option>{(plugins.find((plugin) => plugin.id === step.scriptId)?.actions ?? []).map((action) => <option value={action} key={action}>{action}</option>)}</select></>}
              <input
                value={index === 0 ? value.message : step.message}
                placeholder="送信内容"
                maxLength={512}
                onChange={(event) =>
                  updateStep(index, { message: event.target.value.slice(0, 512) })
                }
              />
              <button className="details-button" onClick={() => update({ steps: value.steps.filter((_, stepIndex) => stepIndex !== index) })}>削除</button>
              <input
                type="number"
                min="-1"
                max="9999"
                value={index === 0 ? value.count : step.count}
                onChange={(event) =>
                  updateStep(index, {
                    count: Number(event.target.value) === -1 ? -1 : Math.min(9999, Math.max(1, Number(event.target.value))),
                  })
                }
              />
            </div>
          ))}
        </div>
        {placeholderOpen && <div className="modal-backdrop nested-modal" onClick={() => setPlaceholderOpen(false)}><section className="placeholder-modal" onClick={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setPlaceholderOpen(false)}>×</button><p className="eyebrow">PLACEHOLDERS</p><h2>プレースホルダー一覧</h2><div className="placeholder-list"><p><code>{"{me}"}</code> 自分のGamertag</p><p><code>{"{random}"}</code> ランダムなプレイヤー</p><p><code>{"{host}"}</code> ワールドホスト</p><p><code>{"{time}"}</code> 現在時刻</p><p><code>{"{time.h}"}</code> 時　<code>{"{time.m}"}</code> 分　<code>{"{time.s}"}</code> 秒</p><p><code>{"{count}"}</code> 現在のプレイヤー人数</p></div></section></div>}
        <div className="modal-section">
          <h3>権限検知</h3>
          <label className="setting-switch">
            <input
              type="checkbox"
              checked={value.detectOperator}
              onChange={(event) =>
                update({ detectOperator: event.target.checked })
              }
            />
            <span />
            OP権限を検知する
          </label>
          <label>
            OP検知時の動作
            <select
              value={value.operatorBehavior}
              onChange={(event) =>
                update({
                  operatorBehavior: event.target
                    .value as AutomationOptions["operatorBehavior"],
                })
              }
            >
              <option value="continue">そのまま継続</option>
              <option value="skip-command">コマンドだけスキップ</option>
              <option value="stop">実行を停止</option>
            </select>
          </label>
          <p className="modal-note">
            Bedrockの権限情報やコマンド結果から判定できた場合に適用されます。
          </p>
        </div>
        <div className="modal-section autokick-section">
          <div className="modal-section-title"><h3>AutoKick</h3><span className="feature-badge">自動処理</span></div>
          <p className="modal-note">自分以外のプレイヤーへ、プレースホルダーを展開した `/tell` コマンドを実行します。</p>
          <label className="setting-switch"><input type="checkbox" checked={value.autoKickEnabled} onChange={(event) => update({ autoKickEnabled: event.target.checked })} /><span />AutoKickを有効にする</label>
          <label>対象プレイヤーへのコマンド<input value={value.autoKickCommand || "/tell {random} @a[name=a]"} onChange={(event) => update({ autoKickCommand: event.target.value || "/tell {random} @a[name=a]" })} onBlur={(event) => { if (!event.currentTarget.value.trim()) update({ autoKickCommand: "/tell {random} @a[name=a]" }); }} placeholder='/tell "playername" @a[name=a]' /></label>
          <label className="setting-switch"><input type="checkbox" checked={value.autoKickHostOnly} onChange={(event) => update({ autoKickHostOnly: event.target.checked })} /><span />ホストに対してのみ送る</label>
          <label className="setting-switch"><input type="checkbox" checked={value.autoAcceptFriendRequests} onChange={(event) => update({ autoAcceptFriendRequests: event.target.checked })} /><span />受信したフレンド申請を自動承認</label>
          <label className="setting-switch"><input type="checkbox" checked={value.autoFriendRequestPlayers} onChange={(event) => update({ autoFriendRequestPlayers: event.target.checked })} /><span />プレイヤー一覧の非フレンドへ自動申請</label>
        </div>
        <button className="primary-button modal-save" onClick={onClose}>
          設定を保存
        </button>
        <button className="details-button" onClick={() => { if (window.confirm("このアカウントのアクション設定を初期化しますか？")) onReset(); }}>
          アクション設定を初期化
        </button>
      </section>
    </div>
  );
}
