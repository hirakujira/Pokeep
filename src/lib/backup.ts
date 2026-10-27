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
  fieldsSchema,
  settingsSchema,
  type Observation,
  type Pokemon,
  type Snapshot,
} from "./types";
import type { Scan, ScanItem, TransferBatch } from "./iphone-types";
import { reevaluate } from "./evaluate";
import { maxTransferSearchFilters } from "./transfer-search-filters";

export const validFrame = (frame: string) =>
  /^[a-zA-Z0-9-]{1,80}\/[a-zA-Z0-9_-]{1,140}\.jpg$/.test(frame);
const evidence = z.object({
  observationId: z.string().max(100),
  frame: z.string().refine(validFrame),
  time: z.number().min(0).max(600),
  video: z.string().max(200),
  fields: z.array(
    z.enum(
      Object.keys(fieldsSchema.shape) as [
        keyof typeof fieldsSchema.shape,
        ...(keyof typeof fieldsSchema.shape)[],
      ],
    ),
  ),
  source: z.enum(["video", "iphone"]).optional(),
  capturedAt: z.string().datetime().optional(),
  scanItemId: z.string().max(100).optional(),
});
export const pokemonBackupSchema = z.object({
  id: z.string().min(1).max(100),
  jobId: z.string().max(100),
  fields: fieldsSchema,
  overrides: fieldsSchema.partial(),
  sources: z.array(evidence).max(10000),
  issues: z.array(z.string().max(500)).max(1000),
  candidates: z.array(z.string().max(100)).max(1000),
  verified: z.boolean(),
  verification: z.enum(["human", "automatic"]).nullable().optional(),
  evolutionSilhouette: z.union([z.boolean(), z.literal("unavailable"), z.literal("unknown-branch")]).nullable().optional(),
  maxStatus: z.enum(["none", "dynamax", "gigantamax"]).nullable().optional(),
  locked: z.boolean(),
  owned: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  analysis: z.unknown().optional(),
});
const observationSchema = z.object({
  id: z.string().max(100),
  jobId: z.string().max(100),
  segment: z.string().max(100),
  frame: z.string().refine(validFrame),
  time: z.number().min(0).max(600),
  video: z.string().max(200),
  fields: fieldsSchema,
  issues: z.array(z.string().max(500)),
  ivMeasured: z.array(z.number().int().min(0).max(15)).length(3).nullable(),
  kind: z.string().max(50),
  source: z.enum(["video", "iphone"]).optional(),
  capturedAt: z.string().datetime().optional(),
  scanItemId: z.string().max(100).optional(),
});
const scanSchema = z.object({
  id: z.string().max(100),
  scope: z.enum(["results", "all"]),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "completed",
    "stopped",
    "failed",
  ]),
  stage: z.string().max(500),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  scanned: z.number().int().nonnegative(),
  phase: z.enum(["capture", "analysis"]).optional(),
  analyzed: z.number().int().nonnegative().optional(),
  review: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative().nullable(),
  sort: z.string().nullable(),
  currentFrame: z.string().nullable(),
  lastFingerprint: z.string().nullable(),
  apiUsage: z.object({
    input: z.number(),
    output: z.number(),
    requests: z.number(),
    cached: z.number(),
    navigationRequests: z.number().optional(),
    dataRequests: z.number().optional(),
  }),
  error: z.string().nullable(),
  checkpointRequired: z.boolean(),
  iphoneUseVersion: z.string().nullable(),
});
const scanItemSchema = z.object({
  id: z.string().max(100),
  scanId: z.string().max(100),
  position: z.number().int().nonnegative(),
  frame: z.string().refine(validFrame),
  appraisalFrame: z.string().refine(validFrame).nullable(),
  movesFrame: z.string().refine(validFrame).optional(),
  measuredIV: z.array(z.number().int().min(0).max(15)).length(3).nullable().optional(),
  fingerprint: z.string(),
  pokemonId: z.string().nullable(),
  fields: fieldsSchema.nullable(),
  issues: z.array(z.string()),
  protectionClear: z.boolean(),
  favoriteRechecked: z.boolean().optional(),
  evolutionSilhouette: z.union([z.boolean(), z.literal("unavailable"), z.literal("unknown-branch")]).nullable().optional(),
  maxStatus: z.enum(["none", "dynamax", "gigantamax"]).nullable().optional(),
  shinyReview: z
    .object({
      verdict: z.enum(["normal", "shiny", "uncertain"]),
      model: z.string().max(100),
      reason: z.string().max(500),
      referenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(2).optional(),
      reviewedAt: z.string().datetime(),
    })
    .optional(),
  specialReview: z
    .object({
      verdict: z.enum(["normal", "shadow", "purified", "uncertain"]),
      model: z.string().max(100),
      reason: z.string().max(400),
      reviewedAt: z.string().datetime(),
    })
    .optional(),
  capturedAt: z.string().datetime(),
  analyzedAt: z.string().datetime().optional(),
});
const transferBatchSchema = z.object({
  id: z.string().max(100),
  scanId: z.string().max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum([
    "draft",
    "approved",
    "running",
    "paused",
    "completed",
    "stopped",
    "stale",
  ]),
  mode: z.enum(["single", "bulk"]).optional(),
  searchExclusions: z.array(z.enum([
    "background", "lucky", "shiny", "costume", "shadow", "purified",
    "favorite", "legendary", "mythical", "ultrabeast", "perfect",
  ])).max(maxTransferSearchFilters).optional(),
  selectedPokemonId: z.string().nullable().optional(),
  needsBoxReturn: z.boolean().optional(),
  signature: z.string(),
  entries: z.array(
    z.object({
      pokemonId: z.string(),
      status: z.enum([
        "pending",
        "searching",
        "prepared",
        "sent",
        "submitted",
        "confirmed",
        "skipped",
        "uncertain",
      ]),
      reason: z.string().nullable(),
      preparedAt: z.string().optional(),
      sentAt: z.string().optional(),
      submittedAt: z.string().optional(),
      confirmedAt: z.string().optional(),
      evidence: z.string().optional(),
    }),
  ),
  error: z.string().nullable(),
  approvedAt: z.string().nullable(),
  hiddenAt: z.string().nullable().optional(),
});
const snapshotSchema = z.object({
  version: z.string().max(100),
  updatedAt: z.string(),
  sourceDate: z.string(),
  sources: z.array(
    z.object({ name: z.string(), url: z.string().url(), version: z.string() }),
  ),
  species: z.record(
    z.string(),
    z.object({
      id: z.string(),
      dex: z.number().int().min(1),
      name: z.string(),
      genderless: z.boolean().optional(),
      types: z.array(z.string()),
      atk: z.number().positive(),
      def: z.number().positive(),
      sta: z.number().positive(),
      fast: z.array(z.string()),
      charged: z.array(z.string()),
      elite: z.array(z.string()),
      tags: z.array(z.string()),
      evolutions: z.array(
        z.object({
          id: z.string(),
          candy: z.number().nonnegative(),
          condition: z.string().nullable(),
          gender: z.string().optional(),
        }),
      ),
      thirdMove: z.object({ dust: z.number(), candy: z.number() }).nullable(),
      form: z.string().nullable(),
    }),
  ),
  moves: z.record(
    z.string(),
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      power: z.number().nonnegative(),
      energy: z.number(),
      duration: z.number().positive(),
    }),
  ),
  rankings: z.record(
    z.string(),
    z.array(
      z.object({
        speciesId: z.string(),
        score: z.number(),
        moves: z.array(z.string()),
      }),
    ),
  ),
  cpm: z.array(z.number().positive()).min(51),
  powerups: z.object({
    dust: z.array(z.number().nonnegative()).min(49),
    candy: z.array(z.number().nonnegative()).min(49),
    xl: z.array(z.number().nonnegative()).min(10),
  }),
  names: z.record(z.string(), z.string()),
  moveNames: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
});
const backupSchema = z.object({
  format: z.literal("pogo-local-backup"),
  version: z.union([z.literal(1), z.literal(2)]),
  pokemon: z.array(pokemonBackupSchema).max(20000),
  observations: z.array(observationSchema).max(50000),
  settings: settingsSchema,
  snapshot: snapshotSchema.nullable(),
  frames: z
    .record(z.string().refine(validFrame), z.string().max(2000000))
    .optional(),
  scans: z.array(scanSchema).max(20000).optional(),
  scanItems: z.array(scanItemSchema).max(50000).optional(),
  transferBatches: z.array(transferBatchSchema).max(20000).optional(),
});
export async function exportBackup() {
  const pokemon = listPokemon(),
    frames: Record<string, string> = {};
  for (const frame of new Set([
    ...pokemon.flatMap((p) => p.sources.map((s) => s.frame)),
    ...all<ScanItem>("scan_items").flatMap((item) =>
      [item.frame, item.movesFrame, item.appraisalFrame].filter((name): name is string =>
        Boolean(name),
      ),
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
  for (const [frame, encoded] of Object.entries(backup.frames || {})) {
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
        put("pokemon", p.id, { ...p, analysis: null } as Pokemon);
        imported++;
      }
    for (const o of backup.observations)
      if (!get("observations", o.id)) put("observations", o.id, o);
    for (const scan of backup.scans || [])
      if (!get("scans", scan.id))
        put("scans", scan.id, {
          ...scan,
          status: scan.status === "completed" ? "completed" : "stopped",
          stage: "從備份還原的歷史掃描",
          error: null,
        } as Scan);
    for (const item of backup.scanItems || [])
      if (!get("scan_items", item.id)) put("scan_items", item.id, item);
    for (const batch of backup.transferBatches || [])
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
        } as TransferBatch);
    if (!get("settings", "preferences"))
      put("settings", "preferences", backup.settings);
  });
  if (!getSnapshot() && backup.snapshot)
    saveSnapshot(backup.snapshot as Snapshot);
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
      p.analysis?.reasons?.join("；") || "",
      p.owned ? "是" : "否",
    ]);
  }
  return "\uFEFF" + lines.map((row) => row.map(cell).join(",")).join("\r\n");
}
