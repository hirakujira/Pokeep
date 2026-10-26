import { all, now, put } from "./store";
import { scanItems, updateScan } from "./iphone-data";
import type { Scan, TransferBatch } from "./iphone-types";

export function recoverInterruptedPhoneWork() {
  for (const scan of all<Scan>("scans")) {
    const legacy = scan.phase === undefined || scan.analyzed === undefined;
    const patch: Partial<Scan> = legacy
      ? {
          phase: scan.status === "completed" ? "analysis" : "capture",
          analyzed: scanItems(scan.id).filter((item) => item.pokemonId).length,
        }
      : {};
    if (scan.status === "running")
      Object.assign(patch, {
        status: "paused",
        stage: "背景服務重新啟動；請檢查手機畫面後續掃",
      });
    if (legacy || scan.status === "running") updateScan(scan.id, patch);
  }
  for (const batch of all<TransferBatch>("transfer_batches"))
    if (batch.status === "running" || batch.status === "approved") {
      const entries = batch.entries.map((entry) =>
        ["searching", "unfavoriting", "prepared", "sent"].includes(entry.status)
          ? {
              ...entry,
              status: "uncertain" as const,
              reason:
                entry.status === "unfavoriting"
                  ? "取消最愛時背景服務中斷；尚未送出放生，請在遊戲查證"
                  : "背景服務中斷；請在遊戲查證，不會自動重送",
            }
          : entry,
      );
      put("transfer_batches", batch.id, {
        ...batch,
        status: "paused",
        selectedPokemonId: null,
        approvedAt: null,
        entries,
        error: "背景服務重新啟動；請查證中途操作",
        updatedAt: now(),
      });
    }
}
