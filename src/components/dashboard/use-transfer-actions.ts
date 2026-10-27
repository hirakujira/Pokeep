import { useState } from "react";
import type { TransferBatch } from "@/lib/iphone-types";
import { resumableTransferIndexes } from "@/lib/iphone-resume";
import type { TransferSearchFilter } from "@/lib/transfer-search-filters";
import { api } from "./api";
import type { Notify, RunAction } from "./types";

export function useTransferActions(
  phoneAct: RunAction,
  notify: Notify,
  searchExclusions: TransferSearchFilter[],
) {
  const [trackedBatchId, setTrackedBatchId] = useState<string | null>(null),
    [dismissedBatchId, setDismissedBatchId] = useState<string | null>(null);
  const track = (batch: TransferBatch) => {
    setTrackedBatchId(batch.id);
    setDismissedBatchId(null);
  };
  const startSelectedTransfers = (pokemonIds: string[]) => {
    void phoneAct("execute-many", async () => {
      const batch = await api<TransferBatch>("transfers/execute-many", "POST", {
        pokemonIds, searchExclusions,
      });
      track(batch);
      notify(`已開始放生 ${pokemonIds.length} 隻`);
    });
  };
  const skipTransferEntry = (pausedBatch: TransferBatch) => {
    void phoneAct("skip-transfer-entry", async () => {
      const skipped = await api<TransferBatch>(`transfers/${pausedBatch.id}/skip-current`, "POST");
      track(skipped);
      const newlyExcluded = skipped.entries.filter((entry, index) =>
        pausedBatch.entries[index]?.status === "pending" && entry.status === "skipped",
      ).length;
      notify(`已跳過這隻${newlyExcluded ? `，另有 ${newlyExcluded} 隻不再符合放生條件也已跳過` : ""}；繼續放生剩餘 ${skipped.entries.filter((entry) => entry.status === "pending").length} 隻`);
    });
  };
  const resumeTransfer = (batch: TransferBatch, announce = true) => {
    void phoneAct("resume-transfer", async () => {
      const resumed = await api<TransferBatch>(`transfers/${batch.id}/resume`, "POST");
      track(resumed);
      if (announce) notify(`繼續放生剩餘 ${resumableTransferIndexes(batch).length} 隻`);
    });
  };
  const stopTransfer = (batch: TransferBatch) => {
    void phoneAct("stop-transfer", async () => {
      await api(`transfers/${batch.id}/stop`, "POST");
    });
  };
  const hideBatch = (batch: TransferBatch) => {
    void phoneAct("hide-transfer", async () => {
      await api(`transfers/${batch.id}/hide`, "POST");
      notify("已清除這筆放生紀錄；資料與備份仍會保留");
    });
  };
  const dismissBatch = (batch: TransferBatch) => setDismissedBatchId(batch.id);
  return {
    trackedBatchId,
    dismissedBatchId,
    startSelectedTransfers,
    skipTransferEntry,
    resumeTransfer,
    stopTransfer,
    hideBatch,
    dismissBatch,
  };
}
export type TransferActions = ReturnType<typeof useTransferActions>;
