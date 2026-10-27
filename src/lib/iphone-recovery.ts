import { all, now, put } from "./store";
import { updateScan } from "./iphone-data";
import type { Scan, TransferBatch } from "./iphone-types";

export function recoverInterruptedPhoneWork() {
  for (const scan of all<Scan>("scans"))
    if (scan.status === "running")
      updateScan(scan.id, {
        status: "paused",
        stage: "背景服務重新啟動；請檢查手機畫面後續掃",
      });
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
