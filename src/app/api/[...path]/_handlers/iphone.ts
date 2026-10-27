import { get, now, put } from "@/lib/store";
import type { Pokemon } from "@/lib/types";
import {
  activeBatch,
  activeScan,
  assertBatchFresh,
  batches,
  scanItems,
  scans,
} from "@/lib/iphone-data";
import { resumableTransferIndexes } from "@/lib/iphone-resume";
import { scanTiming } from "@/lib/scan-timing";
import { json } from "./http";

export function iphoneStatus() {
  const worker = get<{
    updatedAt: string;
    ready: boolean;
    message: string;
    version: string | null;
  }>("settings", "iphone-worker");
  const selectedScan = activeScan() || scans()[0] || null;
  const selectedItems = selectedScan ? scanItems(selectedScan.id) : [];
  const latestBatch = batches()[0];
  return json({
    worker:
      worker && Date.now() - Date.parse(worker.updatedAt) < 15000
        ? worker
        : null,
    scan: selectedScan
      ? {
          ...selectedScan,
          timing: scanTiming(selectedScan, selectedItems),
          review: selectedItems.filter((item) => {
            const record = item.pokemonId
              ? get<Pokemon>("pokemon", item.pokemonId)
              : null;
            return item.pokemonId
              ? !record?.verified || Boolean(record.candidates.length)
              : false;
          }).length,
        }
      : null,
    // Hiding the latest batch clears the panel instead of surfacing an older one.
    batch: activeBatch() || (latestBatch?.hiddenAt ? null : latestBatch) || null,
    resumableBatches: batches()
      .filter((batch) => !batch.hiddenAt && resumableTransferIndexes(batch).length > 0)
      .slice(0, 5)
      .map((batch) => {
        try {
          assertBatchFresh(batch);
          return { ...batch, resumeBlocked: null };
        } catch (error) {
          return { ...batch, resumeBlocked: error instanceof Error ? error.message : "資料已變更" };
        }
      }),
  });
}
export function prepareIphone() {
  put("settings", "iphone-prepare", { requestedAt: now() });
  return json({ ok: true });
}
