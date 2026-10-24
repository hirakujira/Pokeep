import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  dataDir,
  get,
  getSettings,
  getSnapshot,
  id,
  listJobs,
  listPokemon,
  now,
  put,
  remove,
  transaction,
  updateJob,
} from "@/lib/store";
import {
  effective,
  fieldsSchema,
  settingsSchema,
  type Job,
  type Pokemon,
  type VideoFile,
} from "@/lib/types";
import { cancelJob, initializeJobs, newJob, queueJob } from "@/lib/jobs";
import { reevaluate } from "@/lib/evaluate";
import { publicSnapshot, updateGameData } from "@/lib/game-data";
import {
  exportBackup,
  exportCsv,
  importBackup,
  validFrame,
} from "@/lib/backup";
import { probeVideo } from "@/lib/video";

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
function syncJobReviews() {
  for (const j of listJobs().filter((j) => j.status === "review")) {
    const records = listPokemon().filter(
      (p) =>
        p.jobId === j.id ||
        p.sources.some((s) => s.frame.startsWith(`${j.id}/`)),
    );
    if (
      records.length &&
      records.every((p) => p.verified && !p.candidates.length)
    )
      updateJob(j.id, { status: "completed", stage: "核對完成" });
  }
}
async function handle(req: NextRequest, ctx: Context) {
  const { path: parts } = await ctx.params,
    route = parts.join("/"),
    method = req.method;
  guard(req, method !== "GET");
  initializeJobs();
  if (method === "GET" && route === "state")
    return json({
      pokemon: listPokemon(),
      jobs: listJobs(),
      settings: getSettings(),
      snapshot: publicSnapshot(),
      apiConfigured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    });
  if (method === "GET" && route === "species") {
    const snapshot = getSnapshot();
    return json({
      species: Object.values(snapshot?.species || {}).map((s) => ({
        id: s.id,
        name: s.name,
        types: s.types,
      })),
      moves: Object.values(snapshot?.moves || {}).map((m) => ({
        id: m.id,
        name: m.name,
      })),
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
  if (method === "POST" && route === "jobs") {
    const input = z
      .object({ name: z.string().trim().min(1).max(120) })
      .parse(await body(req));
    return json(newJob(input.name), 201);
  }
  if (parts[0] === "jobs" && parts[1]) {
    const jobId = parts[1],
      job = get<Job>("jobs", jobId);
    if (!job) return json({ error: "找不到工作" }, 404);
    if (method === "GET" && parts.length === 2) return json(job);
    if (method === "PUT" && parts[2] === "files") {
      if (job.status !== "queued" || job.stage !== "等待上傳")
        throw new Error("此工作已開始，不能新增影片");
      if (job.files.length >= 20) throw new Error("每批最多 20 段影片");
      const name = path
        .basename(req.nextUrl.searchParams.get("name") || "video.mp4")
        .slice(0, 200);
      if (!/\.(mp4|mov)$/i.test(name)) throw new Error("僅支援 MP4／MOV");
      const fileId = id(),
        dir = path.join(dataDir, "uploads", jobId),
        target = path.join(dir, `${fileId}.video`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = await fs.open(target, "wx");
      let size = 0;
      try {
        const reader = req.body?.getReader();
        if (!reader) throw new Error("沒有收到影片");
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 500 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("每段影片不可超過 500 MB");
          }
          await file.write(chunk.value);
        }
        await file.close();
        const meta = await probeVideo(target, req.signal);
        const current = get<Job>("jobs", jobId)!;
        if (current.status !== "queued" || current.stage !== "等待上傳")
          throw new Error("工作已取消或開始");
        const video: VideoFile = {
          id: fileId,
          name,
          path: target,
          size,
          ...meta,
        };
        updateJob(jobId, { files: [...current.files, video] });
        return json(video, 201);
      } catch (error) {
        await file.close().catch(() => {});
        await fs.rm(target, { force: true });
        throw error;
      }
    }
    if (method === "POST" && parts[2] === "start") {
      const input = z
        .object({ manual: z.boolean().default(false) })
        .parse(await body(req));
      return json(queueJob(jobId, input.manual));
    }
    if (method === "POST" && parts[2] === "cancel") {
      await cancelJob(jobId);
      return json({ ok: true });
    }
  }
  if (method === "PATCH" && parts[0] === "pokemon" && parts.length === 2) {
    const record = get<Pokemon>("pokemon", parts[1]);
    if (!record) return json({ error: "找不到個體" }, 404);
    const input = z
      .object({
        fields: fieldsSchema.partial().optional(),
        verified: z.boolean().optional(),
        locked: z.boolean().optional(),
        owned: z.boolean().optional(),
        dismissCandidates: z.boolean().optional(),
      })
      .strict()
      .parse(await body(req));
    const next = {
      ...record,
      overrides: { ...record.overrides, ...input.fields },
      verified: input.verified ?? (input.fields ? false : record.verified),
      locked: input.locked ?? record.locked,
      owned: input.owned ?? record.owned,
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
    syncJobReviews();
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
    const joined: Pokemon = {
      ...a,
      fields,
      overrides,
      issues: [...new Set(issues)],
      sources: [...a.sources, ...b.sources],
      locked: a.locked || b.locked,
      verified: false,
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
