import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  get,
  getSettings,
  getSnapshot,
  listPokemon,
  now,
  put,
  transaction,
} from "@/lib/store";
import {
  activeBatch,
  activeScan,
  assertBatchFresh,
  batches,
  previewBatch,
  resumeTransferBatch,
  skipCurrentTransferEntry,
  scanItems,
  scans,
} from "@/lib/iphone-data";
import type { TransferBatch } from "@/lib/iphone-types";
import { transferSignature } from "@/lib/iphone-safety";
import { defaultTransferSearchFilters, maxTransferSearchFilters, transferSearchQuery } from "@/lib/transfer-search-filters";
import { body, json } from "./http";

const previewInput = z.object({ scanId: z.string() });
const pokemonIdInput = z.object({ pokemonId: z.string() });
const executeManyInput = z.object({
  pokemonIds: z.array(z.string()).min(1).max(1000),
  searchExclusions: z.array(z.enum([
    "background", "lucky", "shiny", "costume", "shadow", "purified",
    "favorite", "legendary", "mythical", "ultrabeast", "perfect",
  ])).max(maxTransferSearchFilters).default(defaultTransferSearchFilters),
});
type SearchExclusions = z.infer<typeof executeManyInput>["searchExclusions"];

export const listTransfers = () => json(batches());
export async function previewTransfer(req: NextRequest) {
  const { scanId } = previewInput.parse(await body(req));
  return json(previewBatch(scanId), 201);
}
export async function executeOne(req: NextRequest) {
  const { pokemonId } = pokemonIdInput.parse(await body(req));
  return json(approveFromCompletedScan(pokemonId));
}
export async function executeMany(req: NextRequest) {
  const { pokemonIds, searchExclusions } = executeManyInput.parse(await body(req));
  transferSearchQuery(1, searchExclusions);
  if (new Set(pokemonIds).size !== pokemonIds.length)
    throw new Error("放生名單含有重複個體");
  return json(approveSelection(pokemonIds, searchExclusions));
}
export async function transferById(req: NextRequest, id: string, rest: string[]) {
  const batch = get<TransferBatch>("transfer_batches", id);
  if (!batch) return json({ error: "找不到放生批次" }, 404);
  const method = req.method,
    action = rest[0];
  if (method === "GET" && rest.length === 0) return json(batch);
  if (method === "POST" && action === "exclude") {
    if (batch.status !== "draft")
      throw new Error("只能從尚未確認的批次排除個體");
    const { pokemonId } = pokemonIdInput.parse(await body(req));
    return json(excludeEntry(batch, pokemonId));
  }
  if (method === "POST" && action === "execute-one") {
    const { pokemonId } = pokemonIdInput.parse(await body(req));
    return json(approveBatchEntry(batch.id, pokemonId));
  }
  if (method === "POST" && action === "approve") {
    throw new Error("整批放生已停用；請重新預覽並逐隻確認");
  }
  if (method === "POST" && action === "resume")
    return json(resumeTransferBatch(batch.id));
  if (method === "POST" && action === "skip-current")
    return json(skipCurrentTransferEntry(batch.id));
  if (method === "POST" && action === "stop") return json(stopBatch(batch));
}
function approveFromCompletedScan(pokemonId: string) {
  return transaction(() => {
    if (activeScan() || activeBatch())
      throw new Error("手機正在處理其他工作");
    const scan = scans().find(
      (row) =>
        row.status === "completed" &&
        scanItems(row.id).some((item) => item.pokemonId === pokemonId),
    );
    if (!scan)
      throw new Error("找不到包含這隻寶可夢的已完成掃描");
    const batch = previewBatch(scan.id);
    if (
      !batch.entries.some(
        (entry) => entry.pokemonId === pokemonId && entry.status === "pending",
      )
    )
      throw new Error("這隻目前不符合放生條件，請重新檢查收藏資料");
    assertBatchFresh(batch);
    const next: TransferBatch = {
      ...batch,
      status: "approved",
      selectedPokemonId: pokemonId,
      approvedAt: now(),
      updatedAt: now(),
    };
    put("transfer_batches", next.id, next);
    return next;
  });
}
function approveSelection(pokemonIds: string[], searchExclusions: SearchExclusions) {
  return transaction(() => {
    if (activeScan() || activeBatch())
      throw new Error("手機正在處理其他工作");
    const wanted = new Set(pokemonIds);
    const scan = scans().find((row) => {
      if (row.status !== "completed") return false;
      const present = new Set(scanItems(row.id).map((item) => item.pokemonId));
      return pokemonIds.every((id) => present.has(id));
    });
    if (!scan) throw new Error("找不到包含全部勾選個體的已完成掃描");
    const preview = previewBatch(scan.id);
    const entries = preview.entries.filter((entry) => wanted.has(entry.pokemonId));
    if (entries.length !== wanted.size || entries.some((entry) => entry.status !== "pending"))
      throw new Error("部分勾選個體已不符合放生條件，請重新檢查名單");
    const next: TransferBatch = {
      ...preview,
      mode: "bulk",
      searchExclusions,
      entries,
      status: "approved",
      selectedPokemonId: null,
      approvedAt: now(),
      updatedAt: now(),
    };
    next.signature = transferSignature(next, listPokemon(), getSnapshot(), getSettings());
    assertBatchFresh(next);
    put("transfer_batches", next.id, next);
    return next;
  });
}
function excludeEntry(batch: TransferBatch, pokemonId: string) {
  if (
    !batch.entries.some(
      (entry) => entry.pokemonId === pokemonId && entry.status === "pending",
    )
  )
    throw new Error("只能排除尚未執行的候選個體");
  const entries = batch.entries.filter(
    (entry) => entry.pokemonId !== pokemonId,
  );
  if (entries.length === batch.entries.length)
    throw new Error("此個體不在放生名單中");
  const next = {
    ...batch,
    entries,
    updatedAt: now(),
    signature: transferSignature(
      { scanId: batch.scanId, entries },
      listPokemon(),
      getSnapshot(),
      getSettings(),
    ),
  };
  put("transfer_batches", batch.id, next);
  return next;
}
function approveBatchEntry(batchId: string, pokemonId: string) {
  return transaction(() => {
    const latest = get<TransferBatch>("transfer_batches", batchId);
    if (latest?.mode !== "single" || latest.status !== "draft")
      throw new Error("這份名單目前不能逐隻執行，請重新預覽");
    if (activeScan() || activeBatch())
      throw new Error("手機正在處理其他工作");
    if (
      !latest.entries.some(
        (entry) => entry.pokemonId === pokemonId && entry.status === "pending",
      )
    )
      throw new Error("這隻不在尚待執行的放生候選中");
    assertBatchFresh(latest);
    const next: TransferBatch = {
      ...latest,
      status: "approved",
      selectedPokemonId: pokemonId,
      approvedAt: now(),
      updatedAt: now(),
      error: null,
    };
    put("transfer_batches", batchId, next);
    return next;
  });
}
function stopBatch(batch: TransferBatch) {
  if (!["approved", "running", "paused"].includes(batch.status))
    throw new Error("此批次無法停止");
  const stopped = {
    ...batch,
    status: "stopped" as const,
    selectedPokemonId: null,
    approvedAt: null,
    updatedAt: now(),
  };
  put("transfer_batches", batch.id, stopped);
  return stopped;
}
