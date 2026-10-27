import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronDown,
  LoaderCircle,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "./api";
import { date, number } from "./format";
import type { State } from "./types";

export function SettingsView({
  state,
  onAction,
  onRefreshCatalog,
  onToast,
  backupInput,
  busy,
}: {
  state: State;
  onAction: (label: string, fn: () => Promise<void>) => Promise<void>;
  onRefreshCatalog: () => Promise<void>;
  onToast: (text: string) => void;
  backupInput: React.RefObject<HTMLInputElement | null>;
  busy: string;
}) {
  const [preferences, setPreferences] = useState(state.settings);
  const [runtime, setRuntime] = useState(state.runtime);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [showClearPokemon, setShowClearPokemon] = useState(false);
  const [clearConfirmation, setClearConfirmation] = useState("");
  useEffect(
    () => setPreferences(state.settings),
    [
      state.settings.raidSlots,
      state.settings.metaCutoff,
      state.settings.ivCutoff,
      state.settings.rareRepresentatives,
    ],
  );
  useEffect(() => setRuntime(state.runtime), [
    state.runtime.apiConfigured,
    state.runtime.model,
    state.runtime.baseUrl,
    state.runtime.analysisConcurrency,
    state.runtime.shinyReviewConcurrency,
    state.runtime.iphoneUseRoot,
    state.runtime.iphoneUsePython,
  ]);
  return (
    <div className="settings-grid">
      <section className="panel settings-card">
        <h2>AI 辨識（OpenAI）</h2>
        <div
          className={`connection-state ${state.apiConfigured ? "connected" : ""}`}
        >
          <span className="online-dot" />
          {state.apiConfigured ? "API key 已設定" : "尚未設定 API key"}
          <small>{state.model}</small>
        </div>
        <div className="preference-fields">
          <label>
            <span>API key（留空保留已設定的 key）</span>
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              placeholder={state.apiConfigured ? "已設定" : "輸入 API key"}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={clearApiKey}
            />
          </label>
          {state.apiConfigured && (
            <label className="settings-check">
              <input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} />
              <span>清除已儲存的 API key</span>
            </label>
          )}
          <label>
            <span>模型</span>
            <input value={runtime.model} onChange={(event) => setRuntime((value) => ({ ...value, model: event.target.value }))} />
          </label>
          <label>
            <span>AI 伺服器網址（留空使用 OpenAI）</span>
            <input type="url" value={runtime.baseUrl} placeholder="http://127.0.0.1:1234/v1" onChange={(event) => setRuntime((value) => ({ ...value, baseUrl: event.target.value }))} />
          </label>
          <label>
            <span>一般解析並行數（1–8）</span>
            <input type="number" min={1} max={8} value={runtime.analysisConcurrency} onChange={(event) => setRuntime((value) => ({ ...value, analysisConcurrency: Number(event.target.value) }))} />
          </label>
          <label>
            <span>色違複核並行數（1–8）</span>
            <input type="number" min={1} max={8} value={runtime.shinyReviewConcurrency} onChange={(event) => setRuntime((value) => ({ ...value, shinyReviewConcurrency: Number(event.target.value) }))} />
          </label>
        </div>
        <p className="caption">設定儲存在這台 Mac，不會放進匯出的備份。API 依用量計費。</p>
        <a
          className="text-link"
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noreferrer"
        >
          管理 OpenAI API keys
          <ArrowUpRight size={14} />
        </a>
        <h3>iPhone Use</h3>
        <div className="preference-fields">
          <label>
            <span>專案位置</span>
            <input value={runtime.iphoneUseRoot} onChange={(event) => setRuntime((value) => ({ ...value, iphoneUseRoot: event.target.value }))} />
          </label>
          <label>
            <span>Python 指令或執行檔</span>
            <input value={runtime.iphoneUsePython} onChange={(event) => setRuntime((value) => ({ ...value, iphoneUsePython: event.target.value }))} />
          </label>
        </div>
        <button className="button primary" disabled={!!busy} onClick={() => void onAction("runtime-settings", async () => {
          await api("runtime-settings", "PATCH", {
            model: runtime.model,
            baseUrl: runtime.baseUrl,
            analysisConcurrency: runtime.analysisConcurrency,
            shinyReviewConcurrency: runtime.shinyReviewConcurrency,
            iphoneUseRoot: runtime.iphoneUseRoot,
            iphoneUsePython: runtime.iphoneUsePython,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            ...(clearApiKey ? { clearApiKey: true } : {}),
          });
          setApiKey("");
          setClearApiKey(false);
          onToast("連線與解析設定已儲存");
        })}>
          <Check size={15} />儲存連線與解析設定
        </button>
      </section>
      <section className="panel settings-card">
        <h2>遊戲資料</h2>
        <p>更新後會重新評估收藏；失敗時保留舊版本。</p>
        {state.snapshot ? (
          <div className="snapshot-details">
            <div>
              <span>資料日期（PvPoke）</span>
              <strong>{state.snapshot.sourceDate}</strong>
            </div>
            <div>
              <span>更新時間</span>
              <strong>{date(state.snapshot.updatedAt)}</strong>
            </div>
            <div>
              <span>物種／形態</span>
              <strong>{number(state.snapshot.count)}</strong>
            </div>
            <div>
              <span>快照版本</span>
              <code>{state.snapshot.version}</code>
            </div>
          </div>
        ) : (
          <div className="alert">尚未載入資料，請先更新。</div>
        )}
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() =>
            void onAction("data", async () => {
              await api("data/update", "POST");
              await onRefreshCatalog();
              onToast("遊戲資料已更新，已重新評估清倉建議");
            })
          }
        >
          {busy === "data" ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}
          更新遊戲資料
        </button>
        <details className="source-details">
          <summary>
            查看資料來源與計算限制
            <ChevronDown size={14} />
          </summary>
          {state.snapshot?.sources.map((s) => (
            <a key={s.name} href={s.url} target="_blank" rel="noreferrer">
              {s.name}
              <ArrowUpRight size={12} />
            </a>
          ))}
          {state.snapshot?.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <p>
            PvP IV 排名為 4,096 組合、等級上限 50。團體戰採固定防禦 150
            的中性循環 DPS，無天氣、好友或來襲傷害充能。
          </p>
        </details>
      </section>
      <section className="panel settings-card">
        <h2>清倉規則</h2>
        <div className="preference-fields">
          {(
            [
              { key: "raidSlots", label: "每種攻擊屬性保留名額（12 隻可留二軍）", max: 24 },
              { key: "metaCutoff", label: "PvP 環境排名門檻", max: 300 },
              { key: "ivCutoff", label: "PvP 個體 IV 排名門檻", max: 4096 },
              {
                key: "rareRepresentatives",
                label: "每種特殊收藏保留代表數",
                max: 10,
              },
            ] as const
          ).map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input
                type="number"
                min={1}
                max={f.max}
                value={preferences[f.key]}
                onChange={(e) =>
                  setPreferences((p) => ({
                    ...p,
                    [f.key]: Number(e.target.value),
                  }))
                }
              />
            </label>
          ))}
        </div>
        <button
          className="button primary"
          disabled={!!busy}
          onClick={() =>
            void onAction("preferences", async () => {
              await api("settings", "PATCH", preferences);
              onToast("偏好已儲存，已重新評估");
            })
          }
        >
          <Check size={15} />
          儲存並重新評估
        </button>
      </section>
      <section className="panel settings-card">
        <h2>備份與還原</h2>
        <p>JSON 備份包含寶可夢紀錄、人工修正、遊戲資料、掃描紀錄與截圖，不含 API key。</p>
        <div className="storage-summary">
          <strong>{state.pokemon.length}</strong>
          <span>筆寶可夢紀錄</span>
        </div>
        <div className="button-row">
          <a className="button secondary" href="/api/export">
            <ArrowDownToLine size={15} />
            匯出 JSON 備份
          </a>
          <a className="button secondary" href="/api/export?format=csv">
            <ArrowDownToLine size={15} />
            匯出 CSV
          </a>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => backupInput.current?.click()}
          >
            <Upload size={15} />
            匯入 JSON 備份
          </button>
        </div>
        <input
          ref={backupInput}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void onAction("restore", async () => {
                if (file.size > 150 * 1024 * 1024)
                  throw new Error("備份上限為 150 MB");
                const result = await api<{ imported: number; skipped: number }>(
                  "import",
                  "POST",
                  JSON.parse(await file.text()),
                );
                await onRefreshCatalog();
                onToast(
                  `已還原 ${result.imported} 隻，略過 ${result.skipped} 筆既有紀錄`,
                );
              });
            e.target.value = "";
          }}
        />
        <p className="caption">匯入時不會覆蓋既有紀錄與人工修正。</p>
      </section>
      <section className="panel settings-card">
        <h2>清除寶可夢資料</h2>
        <p>清除全部寶可夢、掃描截圖、辨識快取及放生紀錄。連線設定、清倉規則和遊戲資料會保留。此操作無法復原，建議先匯出備份。</p>
        {!showClearPokemon ? (
          <button className="button danger-outline" disabled={!!busy} onClick={() => setShowClearPokemon(true)}>
            <Trash2 size={15} />清除所有寶可夢資料
          </button>
        ) : (
          <div className="preference-fields">
            <label>
              <span>輸入「清除全部寶可夢」以確認</span>
              <input value={clearConfirmation} autoComplete="off" onChange={(event) => setClearConfirmation(event.target.value)} />
            </label>
            <div className="button-row">
              <button className="button secondary" disabled={!!busy} onClick={() => {
                setShowClearPokemon(false);
                setClearConfirmation("");
              }}>取消</button>
              <button className="button danger" disabled={!!busy || clearConfirmation !== "清除全部寶可夢"} onClick={() => void onAction("clear-pokemon", async () => {
                const result = await api<{ removedPokemon: number }>("pokemon/clear-all", "POST", { confirmation: clearConfirmation });
                setShowClearPokemon(false);
                setClearConfirmation("");
                onToast(`已清除 ${result.removedPokemon} 筆寶可夢資料`);
              })}>
                <Trash2 size={15} />確認清除
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
