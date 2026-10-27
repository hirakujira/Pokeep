import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  dataDir,
  get,
  getSettings,
  getSnapshot,
  listPokemon,
  now,
  put,
  remove,
  transaction,
} from "@/lib/store";
import {
  effective,
  fieldsSchema,
  settingsSchema,
  type Pokemon,
} from "@/lib/types";
import { reevaluate } from "@/lib/evaluate";
import { publicSnapshot, updateGameData } from "@/lib/game-data";
import {
  exportBackup,
  exportCsv,
  importBackup,
  validFrame,
} from "@/lib/backup";
import {
  activeBatch,
  activeScan,
  assertBatchFresh,
  batches,
  createScan,
  discardIncompleteScans,
  previewBatch,
  resumeTransferBatch,
  skipCurrentTransferEntry,
  scanItems,
  scans,
  updateScan,
} from "@/lib/iphone-data";
import type { TransferBatch } from "@/lib/iphone-types";
import { transferSignature } from "@/lib/iphone-safety";
import { resumableTransferIndexes } from "@/lib/iphone-resume";
import { pokemonSprite } from "@/lib/sprites";
import { moveName } from "@/lib/move-names";
import { publicRuntimeConfig, saveRuntimeConfig } from "@/lib/runtime-config";
import { clearPokemonData } from "@/lib/clear-pokemon-data";
import { scanTiming } from "@/lib/scan-timing";
import { defaultTransferSearchFilters, transferSearchQuery } from "@/lib/transfer-search-filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
async function body(req: NextRequest, max = 2 * 1024 * 1024) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("缺少請求內容");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("資料過大");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("JSON 格式不正確");
  }
}
function guard(req: NextRequest, mutation = false) {
  const hostHeader = req.headers.get("host"),
    host = hostHeader?.split(":")[0];
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host || ""))
    throw new Error("僅允許本機存取");
  const origin = req.headers.get("origin");
  // Next's production request.url can use its internal hostname; compare the browser origin to the validated Host instead.
  if (
    mutation &&
    (req.headers.get("x-pogo-local") !== "1" ||
      (origin && new URL(origin).host !== hostHeader))
  )
    throw new Error("拒絕跨網站寫入請求");
}
async function handle(req: NextRequest, ctx: Context) {
  const { path: parts } = await ctx.params,
    route = parts.join("/"),
    method = req.method;
  guard(req, method !== "GET");
  if (method === "GET" && route === "iphone") {
    const worker = get<{
      updatedAt: string;
      ready: boolean;
      message: string;
      version: string | null;
    }>("settings", "iphone-worker");
    const selectedScan = activeScan() || scans()[0] || null;
    const selectedItems = selectedScan ? scanItems(selectedScan.id) : [];
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
      batch: activeBatch() || batches()[0] || null,
      resumableBatches: batches()
        .filter((batch) => resumableTransferIndexes(batch).length > 0)
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
  if (method === "POST" && route === "iphone/prepare") {
    put("settings", "iphone-prepare", { requestedAt: now() });
    return json({ ok: true });
  }
  if (method === "GET" && route === "scans") return json(scans());
  if (method === "POST" && route === "scans/discard")
    return json(await discardIncompleteScans());
  if (method === "POST" && route === "scans") {
    const { scope } = z
      .object({ scope: z.enum(["results", "all"]) })
      .parse(await body(req));
    const worker = get<{ updatedAt: string }>("settings", "iphone-worker");
    if (!worker || Date.now() - Date.parse(worker.updatedAt) > 15000)
      throw new Error(
        "iPhone 背景服務尚未啟動，請用 npm run dev 或 npm start 啟動 Pokéep",
      );
    return json(createScan(scope), 201);
  }
  if (parts[0] === "scans" && parts[1]) {
    const scan = get<import("@/lib/iphone-types").Scan>("scans", parts[1]);
    if (!scan) return json({ error: "找不到掃描工作" }, 404);
    if (method === "GET" && parts.length === 2)
      return json({ ...scan, items: scanItems(scan.id) });
    if (method === "POST" && parts[2] === "control") {
      const { action } = z
        .object({ action: z.enum(["pause", "resume", "stop", "finish"]) })
        .parse(await body(req));
      if (action === "finish") {
        if (
          scan.status !== "paused" ||
          scan.phase === "analysis" ||
          scan.expected !== null ||
          !scan.scanned ||
          scanItems(scan.id).length !== scan.scanned
        )
          throw new Error("只能在總數未知且截圖檢查點完整時確認截圖結束");
        if (activeBatch()) throw new Error("放生工作進行中");
        return json(
          updateScan(scan.id, {
            phase: "analysis",
            status: "queued",
            stage: "已確認截圖結束，準備解析",
            checkpointRequired: false,
            error: null,
          }),
        );
      }
      if (action === "pause" && ["queued", "running"].includes(scan.status))
        return json(updateScan(scan.id, { status: "paused", stage: "已暫停" }));
      if (
        action === "stop" &&
        ["queued", "running", "paused"].includes(scan.status)
      )
        return json(
          updateScan(scan.id, { status: "stopped", stage: "已停止" }),
        );
      if (action === "resume" && scan.status === "paused") {
        if (activeBatch()) throw new Error("放生工作進行中");
        return json(
          updateScan(scan.id, {
            status: "queued",
            stage: "準備續掃",
            checkpointRequired: false,
            error: null,
          }),
        );
      }
      throw new Error("目前狀態不能執行此操作");
    }
  }
  if (method === "GET" && route === "transfers") return json(batches());
  if (method === "POST" && route === "transfers") {
    const { scanId } = z.object({ scanId: z.string() }).parse(await body(req));
    return json(previewBatch(scanId), 201);
  }
  if (method === "POST" && route === "transfers/execute-one") {
    const { pokemonId } = z
      .object({ pokemonId: z.string() })
      .parse(await body(req));
    const approved = transaction(() => {
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
    return json(approved);
  }
  if (method === "POST" && route === "transfers/execute-many") {
    const { pokemonIds, searchExclusions } = z
      .object({
        pokemonIds: z.array(z.string()).min(1).max(1000),
        searchExclusions: z.array(z.enum([
          "background", "lucky", "shiny", "costume", "shadow", "purified",
          "favorite", "legendary", "mythical", "ultrabeast", "perfect",
        ])).max(3).default(defaultTransferSearchFilters),
      })
      .parse(await body(req));
    transferSearchQuery(1, searchExclusions);
    if (new Set(pokemonIds).size !== pokemonIds.length)
      throw new Error("放生名單含有重複個體");
    const approved = transaction(() => {
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
    return json(approved);
  }
  if (parts[0] === "transfers" && parts[1]) {
    const batch = get<TransferBatch>("transfer_batches", parts[1]);
    if (!batch) return json({ error: "找不到放生批次" }, 404);
    if (method === "GET" && parts.length === 2) return json(batch);
    if (method === "POST" && parts[2] === "exclude") {
      if (batch.status !== "draft")
        throw new Error("只能從尚未確認的批次排除個體");
      const { pokemonId } = z
        .object({ pokemonId: z.string() })
        .parse(await body(req));
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
      return json(next);
    }
    if (method === "POST" && parts[2] === "execute-one") {
      const { pokemonId } = z
        .object({ pokemonId: z.string() })
        .parse(await body(req));
      const approved = transaction(() => {
        const latest = get<TransferBatch>("transfer_batches", batch.id);
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
        put("transfer_batches", batch.id, next);
        return next;
      });
      return json(approved);
    }
    if (method === "POST" && parts[2] === "approve") {
      throw new Error("整批放生已停用；請重新預覽並逐隻確認");
    }
    if (method === "POST" && parts[2] === "resume")
      return json(resumeTransferBatch(batch.id));
    if (method === "POST" && parts[2] === "skip-current")
      return json(skipCurrentTransferEntry(batch.id));
    if (method === "POST" && parts[2] === "stop") {
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
      return json(stopped);
    }
  }
  if (method === "GET" && route === "state") {
    const runtime = publicRuntimeConfig();
    return json({
      pokemon: listPokemon(),
      settings: getSettings(),
      snapshot: publicSnapshot(),
      apiConfigured: runtime.apiConfigured,
      model: runtime.model,
      runtime,
    });
  }
  if (method === "PATCH" && route === "runtime-settings") {
    if (activeScan() || activeBatch())
      throw new Error("手機工作執行中，請完成或暫停後再修改連線設定");
    return json(saveRuntimeConfig(await body(req)));
  }
  if (method === "POST" && route === "pokemon/clear-all") {
    z.object({
      confirmation: z.literal("清除全部寶可夢"),
    }).strict().parse(await body(req));
    return json(clearPokemonData());
  }
  if (method === "GET" && route === "species") {
    const snapshot = getSnapshot();
    return json({
      species: Object.values(snapshot?.species || {}).map((s) => ({
        id: s.id,
        dex: s.dex,
        name: s.name,
        types: s.types,
      })),
      moves: Object.values(snapshot?.moves || {}).map((m) => ({
        id: m.id,
        name: moveName(m.id, snapshot?.moveNames),
      })),
    });
  }
  if (method === "GET" && parts[0] === "sprites" && parts.length === 2) {
    const sprite = await pokemonSprite(
      parts[1],
      req.nextUrl.searchParams.get("shiny") === "1",
    );
    if (!sprite) return json({ error: "找不到像素圖" }, 404);
    return new Response(new Uint8Array(sprite), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (method === "GET" && parts[0] === "frames") {
    const frame = parts.slice(1).join("/");
    if (!validFrame(frame)) return json({ error: "無效截圖路徑" }, 400);
    try {
      const image = await fs.readFile(path.join(dataDir, "frames", frame));
      return new Response(image, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return json({ error: "來源截圖不存在" }, 404);
    }
  }
  if (method === "GET" && route === "export") {
    const csv = req.nextUrl.searchParams.get("format") === "csv";
    return new Response(
      csv ? exportCsv() : JSON.stringify(await exportBackup()),
      {
        headers: {
          "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json",
          "Content-Disposition": `attachment; filename="pokemon-go-${new Date().toISOString().slice(0, 10)}.${csv ? "csv" : "json"}"`,
          "Cache-Control": "no-store",
        },
      },
    );
  }
  if (method === "POST" && route === "import")
    return json(await importBackup(await body(req, 150 * 1024 * 1024)));
  if (method === "PATCH" && parts[0] === "pokemon" && parts.length === 2) {
    const record = get<Pokemon>("pokemon", parts[1]);
    if (!record) return json({ error: "找不到個體" }, 404);
    const input = z
      .object({
        fields: fieldsSchema.partial().optional(),
        verified: z.boolean().optional(),
        locked: z.boolean().optional(),
        owned: z.boolean().optional(),
        evolutionSilhouette: z.union([z.boolean(), z.literal("unavailable"), z.literal("unknown-branch")]).nullable().optional(),
        maxStatus: z.enum(["none", "dynamax", "gigantamax"]).nullable().optional(),
        dismissCandidates: z.boolean().optional(),
      })
      .strict()
      .parse(await body(req));
    const next = {
      ...record,
      overrides: { ...record.overrides, ...input.fields },
      verified: input.verified ?? (input.fields ? false : record.verified),
      verification:
        input.verified === true
          ? ("human" as const)
          : input.verified === false || input.fields
            ? null
            : record.verification,
      locked: input.locked ?? record.locked,
      owned: input.owned ?? record.owned,
      evolutionSilhouette:
        input.evolutionSilhouette === undefined
          ? record.evolutionSilhouette
          : input.evolutionSilhouette,
      maxStatus:
        input.maxStatus === undefined ? record.maxStatus : input.maxStatus,
      updatedAt: now(),
    };
    const merged = effective(next);
    if (merged.speciesId && !getSnapshot()?.species[merged.speciesId])
      throw new Error("物種 ID 不存在於目前資料快照");
    if (merged.shadow && merged.purified)
      throw new Error("不能同時為暗影與淨化");
    if (
      merged.speciesId &&
      merged.shadow !== null &&
      Boolean(
        getSnapshot()?.species[merged.speciesId]?.tags.includes("shadow"),
      ) !== merged.shadow
    )
      throw new Error("暗影狀態與所選物種不一致，請選擇對應的一般／暗影形態。");
    if (input.dismissCandidates || input.owned === false) {
      const peers = next.candidates;
      next.candidates = [];
      for (const peerId of peers) {
        const peer = get<Pokemon>("pokemon", peerId);
        if (peer)
          put("pokemon", peer.id, {
            ...peer,
            candidates: peer.candidates.filter((p) => p !== next.id),
          });
      }
    }
    put("pokemon", next.id, next);
    reevaluate();
    return json(get<Pokemon>("pokemon", next.id));
  }
  if (method === "POST" && route === "merge") {
    const input = z
      .object({ target: z.string(), source: z.string() })
      .parse(await body(req));
    if (input.target === input.source) throw new Error("不能與自己合併");
    const a = get<Pokemon>("pokemon", input.target),
      b = get<Pokemon>("pokemon", input.source);
    if (!a || !b) throw new Error("找不到要合併的個體");
    const fields = { ...a.fields },
      issues = [...a.issues, ...b.issues],
      overrides = { ...b.overrides, ...a.overrides };
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      if (fields[key] === null)
        (fields as Record<string, unknown>)[key] = b.fields[key];
      else if (b.fields[key] !== null && fields[key] !== b.fields[key])
        issues.push(`合併後請核對衝突欄位：${key}`);
    }
    const maxConflict = a.maxStatus != null && b.maxStatus != null &&
      a.maxStatus !== b.maxStatus;
    if (maxConflict) issues.push("合併後請核對極巨化狀態衝突");
    const joined: Pokemon = {
      ...a,
      fields,
      overrides,
      maxStatus: maxConflict ? null : a.maxStatus ?? b.maxStatus ?? null,
      issues: [...new Set(issues)],
      sources: [...a.sources, ...b.sources],
      locked: a.locked || b.locked,
      verified: false,
      verification: null,
      candidates: [...new Set([...a.candidates, ...b.candidates])].filter(
        (x) => x !== a.id && x !== b.id,
      ),
      updatedAt: now(),
    };
    transaction(() => {
      put("pokemon", a.id, joined);
      remove("pokemon", b.id);
      for (const peer of listPokemon()) {
        if (peer.id !== a.id && peer.candidates.includes(b.id))
          put("pokemon", peer.id, {
            ...peer,
            candidates: [
              ...new Set(peer.candidates.map((k) => (k === b.id ? a.id : k))),
            ].filter((k) => k !== peer.id),
          });
      }
    });
    reevaluate();
    return json(get<Pokemon>("pokemon", a.id));
  }
  if (method === "POST" && route === "reevaluate") {
    reevaluate();
    return json({ ok: true });
  }
  if (method === "PATCH" && route === "settings") {
    const settings = settingsSchema.parse(await body(req));
    put("settings", "preferences", settings);
    reevaluate();
    return json(settings);
  }
  if (method === "POST" && route === "data/update") {
    const snapshot = await updateGameData();
    reevaluate();
    return json(publicSnapshot(snapshot));
  }
  return json({ error: "找不到此介面" }, 404);
}
async function respond(req: NextRequest, ctx: Context) {
  try {
    return await handle(req, ctx);
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? "欄位格式不正確：" +
          error.issues
            .map((i) => `${i.path.join(".")} ${i.message}`)
            .slice(0, 5)
            .join("；")
        : error instanceof Error
          ? error.message
          : "發生未知錯誤";
    return json({ error: message }, 400);
  }
}
export const GET = respond;
export const POST = respond;
export const PATCH = respond;
export const PUT = respond;
