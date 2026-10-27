import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import {
  all,
  dataDir,
  get,
  getSettings,
  getSnapshot,
  listPokemon,
  now,
  put,
  saveSnapshot,
  transaction,
} from "./store";
import {
  observationSchema,
  pokemonSchema,
  settingsSchema,
  snapshotSchema,
  validFrame,
  type Observation,
} from "./types";
import {
  scanItemSchema,
  scanSchema,
  transferBatchSchema,
  type Scan,
  type ScanItem,
  type TransferBatch,
} from "./iphone-types";
import { reevaluate } from "./evaluate";

const backupSchema = z.object({
  format: z.literal("pogo-local-backup"),
  version: z.literal(2),
  pokemon: z.array(pokemonSchema).max(20000),
  observations: z.array(observationSchema).max(50000),
  settings: settingsSchema,
  snapshot: snapshotSchema.nullable(),
  frames: z.record(z.string().refine(validFrame), z.string().max(2000000)),
  scans: z.array(scanSchema).max(20000),
  scanItems: z.array(scanItemSchema).max(50000),
  transferBatches: z.array(transferBatchSchema).max(20000),
});
export async function exportBackup() {
  const pokemon = listPokemon(),
    frames: Record<string, string> = {};
  for (const frame of new Set([
    ...pokemon.flatMap((p) => p.sources.map((s) => s.frame)),
    ...all<ScanItem>("scan_items").flatMap((item) =>
      [item.frame, item.movesFrame, item.appraisalFrame],
    ),
    ...all<TransferBatch>("transfer_batches").flatMap((batch) =>
      batch.entries
        .map((entry) => entry.evidence)
        .filter((name): name is string => Boolean(name)),
    ),
  ]))
    if (validFrame(frame)) {
      try {
        frames[frame] = (
          await fs.readFile(path.join(dataDir, "frames", frame))
        ).toString("base64");
      } catch {}
    }
  return {
    format: "pogo-local-backup",
    version: 2,
    exportedAt: now(),
    pokemon,
    observations: all<Observation>("observations"),
    scans: all<Scan>("scans"),
    scanItems: all<ScanItem>("scan_items"),
    transferBatches: all<TransferBatch>("transfer_batches"),
    settings: getSettings(),
    snapshot: getSnapshot(),
    frames,
  };
}
export async function importBackup(input: unknown) {
  const backup = backupSchema.parse(input);
  let imported = 0;
  // Do not replace existing records or their manual corrections when restoring a second time.
  for (const [frame, encoded] of Object.entries(backup.frames)) {
    const target = path.join(dataDir, "frames", frame);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 1500000) throw new Error("備份截圖過大");
    await fs.writeFile(target, bytes, { flag: "wx" }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  transaction(() => {
    for (const p of backup.pokemon)
      if (!get("pokemon", p.id)) {
        put("pokemon", p.id, { ...p, analysis: null });
        imported++;
      }
    for (const o of backup.observations)
      if (!get("observations", o.id)) put("observations", o.id, o);
    for (const scan of backup.scans)
      if (!get("scans", scan.id))
        put("scans", scan.id, {
          ...scan,
          status: scan.status === "completed" ? "completed" : "stopped",
          stage: "從備份還原的歷史掃描",
          error: null,
        });
    for (const item of backup.scanItems)
      if (!get("scan_items", item.id)) put("scan_items", item.id, item);
    for (const batch of backup.transferBatches)
      if (!get("transfer_batches", batch.id))
        put("transfer_batches", batch.id, {
          ...batch,
          status: "stopped",
          approvedAt: null,
          selectedPokemonId: null,
          entries: batch.entries.map((entry) =>
            entry.status === "confirmed" || entry.status === "submitted" || entry.status === "skipped"
              ? entry
              : {
                  ...entry,
                  status: "uncertain" as const,
                  reason: "備份還原；不會恢復執行授權",
                },
          ),
        });
    if (!get("settings", "preferences"))
      put("settings", "preferences", backup.settings);
  });
  if (!getSnapshot() && backup.snapshot)
    saveSnapshot(backup.snapshot);
  reevaluate();
  return { imported, skipped: backup.pokemon.length - imported };
}
export function exportCsv(records = listPokemon()) {
  const cell = (v: unknown) =>
    `"${String(v ?? "")
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  const lines = [
    [
      "ID",
      "名稱",
      "物種",
      "CP",
      "攻IV",
      "防IV",
      "HP IV",
      "分類",
      "理由",
      "仍持有",
    ],
  ];
  for (const p of records) {
    const f = { ...p.fields, ...p.overrides };
    lines.push([
      p.id,
      f.name || "",
      f.speciesId || "",
      String(f.cp ?? ""),
      String(f.ivAtk ?? ""),
      String(f.ivDef ?? ""),
      String(f.ivSta ?? ""),
      p.analysis?.category || "review",
      p.analysis?.reasons.join("；") || "",
      p.owned ? "是" : "否",
    ]);
  }
  return "\uFEFF" + lines.map((row) => row.map(cell).join(",")).join("\r\n");
}
