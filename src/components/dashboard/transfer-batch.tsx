import { effective, type Pokemon } from "@/lib/types";
import type { TransferBatch } from "@/lib/iphone-types";
import { resumableTransferIndexes, skippableTransferIndex } from "@/lib/iphone-resume";
import { defaultTransferSearchFilters, transferSearchFilters } from "@/lib/transfer-search-filters";
import { entryStatusLabels } from "./constants";
import { displayPokemonName } from "./format";
import type { PhoneState } from "./types";
import type { TransferActions } from "./use-transfer-actions";

const hiddenRecordNote = "只從畫面移除，資料庫與備份仍保留這筆紀錄";

export function transferProgress(batch: TransferBatch, records: Pokemon[]) {
  const resumableCount = resumableTransferIndexes(batch).length;
  const skippableIndex = skippableTransferIndex(batch);
  const skippablePokemon = skippableIndex === null ? null :
    records.find((pokemon) => pokemon.id === batch.entries[skippableIndex].pokemonId);
  const processed = batch.entries.filter((entry) =>
    ["submitted", "confirmed", "skipped", "uncertain"].includes(entry.status),
  ).length;
  const skipped = batch.entries.filter((entry) => entry.status === "skipped").length;
  const activeEntry = batch.entries.find((entry) =>
    ["searching", "prepared", "sent", "unfavoriting"].includes(entry.status),
  );
  const activePokemon = activeEntry
    ? records.find((p) => p.id === activeEntry.pokemonId)
    : null;
  const activeName = activePokemon ? effective(activePokemon).name : null;
  const activeStage = activeEntry?.status === "searching"
    ? "排除背卡、核對 CP"
    : activeEntry?.status === "prepared"
      ? "準備放生"
      : activeEntry?.status === "sent"
        ? "已送出指令"
        : activeEntry?.status === "unfavoriting"
          ? "取消最愛"
          : null;
  const statusLabel = batch.status === "approved" ? "準備開始" :
    batch.status === "running" ? "處理中" :
    batch.status === "paused" ? "已暫停" :
    batch.status === "completed" ? "已完成" :
    batch.status === "stopped" ? "已停止" : "待確認";
  return {
    resumableCount,
    skippableIndex,
    skippablePokemon,
    processed,
    skipped,
    activeName,
    activeStage,
    statusLabel,
  };
}
export type TransferProgress = ReturnType<typeof transferProgress>;

export function BatchProgressPanel({
  batch,
  progress,
  records,
  busy,
  onSelect,
  actions,
}: {
  batch: TransferBatch;
  progress: TransferProgress;
  records: Pokemon[];
  busy: string;
  onSelect: (id: string) => void;
  actions: TransferActions;
}) {
  return (
    <section className="panel iphone-panel">
      <div className="panel-heading">
        <div>
          <h2>放生進度</h2>
          <p>特殊背卡或無法確認身分的寶可夢會自動跳過。</p>
        </div>
        <span className="subtle-tag">{progress.statusLabel}</span>
      </div>
      <p className="muted">
        已處理 {progress.processed} / {batch.entries.length} 隻 · 跳過 {progress.skipped} 隻
      </p>
      <p className="muted">
        手機搜尋排除：{(batch.searchExclusions || defaultTransferSearchFilters)
          .map((id) => transferSearchFilters.find((option) => option.id === id)?.label)
          .filter(Boolean).join("、") || "未選"}
      </p>
      {batch.error && <p className="job-error">{batch.error}</p>}
      {progress.resumableCount > 0 && (
        <p className="muted">
          {progress.skippableIndex !== null
            ? "按「跳過這隻並繼續」會先按 X 返回列表，再搜尋下一隻；若要重試目前個體，請先手動返回列表。"
            : "先在手機返回寶可夢盒子列表，再按「繼續」；已送出的個體不會重送。"}
        </p>
      )}
      {progress.skippableIndex !== null && (
        <p className="muted">
          可跳過 {progress.skippablePokemon ? `${effective(progress.skippablePokemon).name || "這隻寶可夢"} · CP ${effective(progress.skippablePokemon).cp ?? "?"}` : "這隻寶可夢"}；它會維持持有，不會再由此批次放生。
        </p>
      )}
      <details>
        <summary>查看逐隻紀錄</summary>
        <div className="iphone-candidates">
          {batch.entries.map((entry, index) => {
            const pokemon = records.find((row) => row.id === entry.pokemonId);
            if (!pokemon) return null;
            const f = effective(pokemon);
            return (
              <div className="iphone-candidate" key={`${entry.pokemonId}-${index}`}>
                {pokemon.sources[0]?.frame && (
                  <img
                    src={`/api/frames/${pokemon.sources[0].frame}`}
                    alt={`${f.name || "寶可夢"}來源畫面`}
                  />
                )}
                <div>
                  <strong>{displayPokemonName(f.name || f.speciesId || "寶可夢", f.costume, f.speciesId)} · CP {f.cp ?? "?"}</strong>
                  <small>{entryStatusLabels[entry.status]}</small>
                  {entry.reason && <small>{entry.reason}</small>}
                </div>
                <button className="button small secondary" onClick={() => onSelect(pokemon.id)}>
                  查看來源
                </button>
              </div>
            );
          })}
        </div>
      </details>
      {progress.skippableIndex !== null && (
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => actions.skipTransferEntry(batch)}
        >
          跳過這隻並繼續
        </button>
      )}
      {progress.resumableCount > 0 && (
        <button
          className="button"
          disabled={!!busy}
          onClick={() => actions.resumeTransfer(batch)}
        >
          繼續放生剩餘 {progress.resumableCount} 隻
        </button>
      )}
      {["approved", "running", "paused"].includes(batch.status) && (
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => actions.stopTransfer(batch)}
        >
          停止批次
        </button>
      )}
      {!["approved", "running"].includes(batch.status) && (
        <button
          className="button secondary"
          disabled={!!busy}
          title={hiddenRecordNote}
          onClick={() => actions.hideBatch(batch)}
        >
          清除紀錄
        </button>
      )}
    </section>
  );
}

export function PausedBatchesPanel({
  batches,
  batch,
  busy,
  actions,
}: {
  batches: PhoneState["resumableBatches"];
  batch: TransferBatch | null | undefined;
  busy: string;
  actions: TransferActions;
}) {
  return (
    <section className="panel iphone-panel">
      <div className="panel-heading">
        <div>
          <h2>先前暫停的放生</h2>
          <p>可繼續原批次中尚未送出的個體，無須重新勾選。</p>
        </div>
      </div>
      {batches.filter((row) => row.id !== batch?.id).map((row) => (
        <div className="iphone-candidate" key={row.id}>
          <span>已處理 {row.entries.filter((entry) => ["submitted", "confirmed", "skipped", "uncertain"].includes(entry.status)).length}/{row.entries.length} · {row.resumeBlocked || row.error}</span>
          {skippableTransferIndex(row) !== null && (
            <button
              className="button small secondary"
              disabled={!!busy || !!row.resumeBlocked || ["approved", "running"].includes(batch?.status || "")}
              onClick={() => actions.skipTransferEntry(row)}
            >
              跳過這隻並繼續
            </button>
          )}
          <button
            className="button small"
            disabled={!!busy || !!row.resumeBlocked || ["approved", "running"].includes(batch?.status || "")}
            onClick={() => actions.resumeTransfer(row)}
          >
            繼續放生剩餘 {resumableTransferIndexes(row).length} 隻
          </button>
          <button
            className="button small secondary"
            disabled={!!busy}
            title={hiddenRecordNote}
            onClick={() => actions.hideBatch(row)}
          >
            清除紀錄
          </button>
        </div>
      ))}
    </section>
  );
}

export function TransferToast({
  batch,
  progress,
  busy,
  actions,
}: {
  batch: TransferBatch;
  progress: TransferProgress;
  busy: string;
  actions: TransferActions;
}) {
  return (
    <div className="toast transfer-progress-toast" role="status" aria-live="polite">
      <span>
        放生{progress.statusLabel} · 已處理 {progress.processed}/{batch.entries.length}
        {progress.skipped ? ` · 跳過 ${progress.skipped}` : ""}
        {progress.activeName ? ` · 目前 ${progress.activeName}${progress.activeStage ? `：${progress.activeStage}` : ""}` : ""}
        {batch.error ? ` · ${batch.error}` : ""}
      </span>
      {["approved", "running"].includes(batch.status) ? (
        <button
          className="transfer-toast-button"
          disabled={!!busy}
          onClick={() => actions.stopTransfer(batch)}
        >
          停止
        </button>
      ) : progress.resumableCount > 0 ? (
        <>
          {progress.skippableIndex !== null && (
            <button
              className="transfer-toast-button"
              disabled={!!busy}
              onClick={() => actions.skipTransferEntry(batch)}
            >
              跳過這隻並繼續
            </button>
          )}
          <button
            className="transfer-toast-button"
            disabled={!!busy}
            onClick={() => actions.resumeTransfer(batch, false)}
          >
            繼續
          </button>
        </>
      ) : (
        <button className="transfer-toast-button" onClick={() => actions.dismissBatch(batch)}>
          關閉
        </button>
      )}
    </div>
  );
}
