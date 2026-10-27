import fs from "node:fs/promises";
import path from "node:path";
import {
  all,
  dataDir,
  get,
  getSettings,
  getSnapshot,
  id,
  listPokemon,
  listObservations,
  now,
  put,
  remove,
  transaction,
} from "./store";
import { reevaluate } from "./evaluate";
import {
  blockingEvidenceIssues,
  transferExclusion,
  transferSignature,
} from "./iphone-safety";
import type { Scan, ScanItem, TransferBatch } from "./iphone-types";
import { resumableTransferIndexes, skippableTransferIndex } from "./iphone-resume";
import { getRuntimeConfig } from "./runtime-config";
import type { Pokemon } from "./types";

export const scans = () => all<Scan>("scans").reverse();
export const scanItems = (scanId: string) =>
  all<ScanItem>("scan_items")
    .filter((item) => item.scanId === scanId)
    .sort((a, b) => a.position - b.position);
export const batches = () => all<TransferBatch>("transfer_batches").reverse();
export const activeScan = () =>
  scans().find((scan) => ["queued", "running"].includes(scan.status));
export const activeBatch = () =>
  batches().find((batch) => ["approved", "running"].includes(batch.status));

export async function discardIncompleteScans() {
  if (activeScan() || activeBatch())
    throw new Error("手機仍有工作在執行；請先暫停或停止");
  const targets = scans().filter((scan) =>
    ["paused", "stopped", "failed"].includes(scan.status),
  );
  if (!targets.length) throw new Error("沒有可捨棄的未完成掃描");
  const targetIds = new Set(targets.map((scan) => scan.id));
  const operation = get<{ scanId: string; updatedAt: string }>(
    "settings",
    "iphone-operation",
  );
  if (
    operation &&
    targetIds.has(operation.scanId) &&
    Date.now() - Date.parse(operation.updatedAt) < 15000
  )
    throw new Error("背景服務仍在處理目前畫面，請稍後再重來");
  if (
    targets.some((scan) => !/^[a-zA-Z0-9-]{1,80}$/.test(scan.id))
  )
    throw new Error("掃描識別碼無效，無法安全清除來源截圖");
  if (batches().some((batch) => targetIds.has(batch.scanId)))
    throw new Error("未完成掃描已有放生紀錄，不能清除執行歷史");
  const items = targets.flatMap((scan) => scanItems(scan.id));
  const itemIds = new Set(items.map((item) => item.id));
  const belongsToTarget = (source: Pokemon["sources"][number]) =>
    (source.scanItemId && itemIds.has(source.scanItemId)) ||
    targetIds.has(source.frame.split("/")[0]);
  const allPokemon = listPokemon();
  const affected = allPokemon.filter(
    (pokemon) =>
      targetIds.has(pokemon.jobId) ||
      pokemon.sources.some(belongsToTarget),
  );
  if (
    affected.some((pokemon) =>
      pokemon.sources.some((source) => !belongsToTarget(source)),
    )
  )
    throw new Error("有個體已跨次掃描合併，請先處理來源後再捨棄掃描");
  const pokemonIds = new Set(affected.map((pokemon) => pokemon.id));
  transaction(() => {
    for (const scan of targets) {
      for (const observation of listObservations(scan.id))
        remove("observations", observation.id);
      remove("scans", scan.id);
    }
    for (const item of items) remove("scan_items", item.id);
    for (const pokemon of affected) remove("pokemon", pokemon.id);
    for (const pokemon of allPokemon) {
      if (pokemonIds.has(pokemon.id)) continue;
      const candidates = pokemon.candidates.filter(
        (candidate) => !pokemonIds.has(candidate),
      );
      if (candidates.length !== pokemon.candidates.length)
        put("pokemon", pokemon.id, { ...pokemon, candidates });
    }
  });
  reevaluate();
  const cleanup = await Promise.allSettled(
    targets.map((scan) =>
      fs.rm(path.join(dataDir, "frames", scan.id), {
        recursive: true,
        force: true,
      }),
    ),
  );
  return {
    discardedScans: targets.length,
    discardedPokemon: affected.length,
    frameCleanupFailed: cleanup.filter((result) => result.status === "rejected")
      .length,
  };
}

export function createScan(scope: Scan["scope"]) {
  if (!getRuntimeConfig().apiKey)
    throw new Error("自動掃描需要先到網頁「設定」頁填入 API key");
  if (activeScan() || activeBatch()) throw new Error("已有手機工作在執行");
  const scan: Scan = {
    id: id(),
    scope,
    status: "queued",
    stage: "等待手機連線",
    createdAt: now(),
    updatedAt: now(),
    scanned: 0,
    phase: "capture",
    analyzed: 0,
    review: 0,
    expected: null,
    sort: null,
    currentFrame: null,
    lastFingerprint: null,
    apiUsage: {
      input: 0,
      output: 0,
      requests: 0,
      cached: 0,
      navigationRequests: 0,
      dataRequests: 0,
    },
    error: null,
    checkpointRequired: false,
    iphoneUseVersion: null,
  };
  put("scans", scan.id, scan);
  return scan;
}
export function updateScan(idValue: string, patch: Partial<Scan>) {
  const current = get<Scan>("scans", idValue);
  if (!current) throw new Error("找不到掃描工作");
  const result = { ...current, ...patch, updatedAt: now() };
  put("scans", idValue, result);
  return result;
}
export function previewBatch(scanId: string) {
  const scan = get<Scan>("scans", scanId);
  if (!scan || scan.status !== "completed")
    throw new Error("掃描必須完整完成才能建立放生批次");
  if (activeScan() || activeBatch()) throw new Error("已有手機工作在執行");
  const items = scanItems(scanId);
  if (
    items.length !== scan.scanned ||
    items.some((item) => !item.pokemonId || !item.fields)
  )
    throw new Error("掃描截圖尚未全部解析，不能建立放生批次");
  const records = listPokemon();
  const selected = items.flatMap((item) => {
    if (!item.pokemonId || !item.protectionClear) return [];
    const p = records.find((row) => row.id === item.pokemonId);
    if (
      blockingEvidenceIssues(item.issues, item.fields).length &&
      p?.verification !== "human"
    )
      return [];
    return p && !transferExclusion(p, getSnapshot())
      ? [{ pokemonId: p.id, status: "pending" as const, reason: null }]
      : [];
  });
  const entries = [
    ...new Map(selected.map((entry) => [entry.pokemonId, entry])).values(),
  ];
  const batch: TransferBatch = {
    id: id(),
    scanId,
    createdAt: now(),
    updatedAt: now(),
    status: "draft",
    mode: "single",
    selectedPokemonId: null,
    signature: "",
    entries,
    error: null,
    approvedAt: null,
  };
  batch.signature = transferSignature(
    batch,
    records,
    getSnapshot(),
    getSettings(),
  );
  put("transfer_batches", batch.id, batch);
  return batch;
}
export function assertBatchFresh(batch: TransferBatch) {
  if (
    batch.signature !==
    transferSignature(batch, listPokemon(), getSnapshot(), getSettings())
  )
    throw new Error("收藏資料、分析或設定已改變；請重新預覽放生名單");
  for (const entry of batch.entries.filter((row) => row.status === "pending")) {
    const p = listPokemon().find((row) => row.id === entry.pokemonId);
    if (!p || transferExclusion(p, getSnapshot()))
      throw new Error("放生名單包含已不符合條件的個體，請重新預覽");
  }
}

export function resumeTransferBatch(batchId: string) {
  return transaction(() => {
    const batch = get<TransferBatch>("transfer_batches", batchId);
    if (!batch || batch.status !== "paused")
      throw new Error("只有已暫停的放生批次可以繼續");
    if (activeScan() || activeBatch())
      throw new Error("手機正在處理其他工作");
    const indexes = resumableTransferIndexes(batch);
    if (!indexes.length)
      throw new Error("沒有可安全續跑的個體；結果不明者請先在遊戲查證");
    const retry = new Set(indexes);
    const entries = batch.entries.map((entry, index) =>
      retry.has(index) && entry.status === "skipped"
        ? {
            ...entry,
            status: "pending" as const,
            reason: null,
            preparedAt: undefined,
            sentAt: undefined,
            submittedAt: undefined,
            confirmedAt: undefined,
            evidence: undefined,
          }
        : entry,
    );
    const next: TransferBatch = {
      ...batch,
      entries,
      status: "approved",
      selectedPokemonId:
        batch.mode === "single" ? entries[indexes[0]].pokemonId : null,
      approvedAt: now(),
      updatedAt: now(),
      error: null,
    };
    assertBatchFresh(next);
    put("transfer_batches", next.id, next);
    return next;
  });
}

export function skipCurrentTransferEntry(batchId: string) {
  return transaction(() => {
    const batch = get<TransferBatch>("transfer_batches", batchId);
    if (!batch || batch.status !== "paused")
      throw new Error("只有已暫停的放生批次可以跳過目前個體");
    if (activeScan() || activeBatch())
      throw new Error("手機正在處理其他工作");
    const index = skippableTransferIndex(batch);
    if (index === null)
      throw new Error("目前個體無法安全跳過；已送出或結果不明者請先在遊戲查證");
    const records = new Map(listPokemon().map((pokemon) => [pokemon.id, pokemon]));
    const snapshot = getSnapshot();
    const entries = batch.entries.map((entry, position) => {
      if (position === index)
        return { ...entry, reason: `使用者選擇跳過（尚未送出放生）：${entry.reason}` };
      if (entry.status !== "pending") return entry;
      const pokemon = records.get(entry.pokemonId);
      const exclusion = pokemon
        ? transferExclusion(pokemon, snapshot)
        : "收藏資料已不存在";
      return exclusion
        ? { ...entry, status: "skipped" as const, reason: `已不符合放生條件：${exclusion}` }
        : entry;
    });
    if (!entries.some((entry) => entry.status === "pending"))
      throw new Error("其餘個體都已不符合放生條件，沒有可以繼續的名單");
    const next: TransferBatch = {
      ...batch,
      entries,
      status: "approved",
      selectedPokemonId: null,
      approvedAt: now(),
      updatedAt: now(),
      error: null,
    };
    assertBatchFresh(next);
    put("transfer_batches", next.id, next);
    return next;
  });
}
