import fs from "node:fs/promises";
import path from "node:path";
import {
  dataDir,
  get,
  getSnapshot,
  id,
  listJobs,
  listObservations,
  listPokemon,
  now,
  put,
  transaction,
  updateJob,
} from "./store";
import { extractFrames, type SelectedFrame } from "./video";
import { manualObservation, recognize, reconcileIV } from "./vision";
import { integrateObservations } from "./matching";
import { reevaluate } from "./evaluate";
import type { Job, Observation } from "./types";

type Runtime = {
  running: boolean;
  pending: { jobId: string; manual: boolean }[];
  controllers: Map<string, AbortController>;
  initialized: boolean;
};
const globals = globalThis as unknown as { pogoJobs?: Runtime };
function runtime() {
  if (!globals.pogoJobs)
    globals.pogoJobs = {
      running: false,
      pending: [],
      controllers: new Map(),
      initialized: false,
    };
  if (!globals.pogoJobs.initialized) {
    globals.pogoJobs.initialized = true;
    for (const job of listJobs())
      if (
        job.status === "processing" ||
        (job.status === "queued" && job.stage !== "等待上傳")
      )
        updateJob(job.id, {
          status: "failed",
          stage: "工作中斷",
          error: "本機服務曾重新啟動；已保留完成的畫面與辨識，可重試。",
        });
  }
  return globals.pogoJobs;
}
export function newJob(name: string): Job {
  runtime();
  const job: Job = {
    id: id(),
    name,
    status: "queued",
    stage: "等待上傳",
    progress: 0,
    files: [],
    error: null,
    createdAt: now(),
    updatedAt: now(),
    usage: { input: 0, output: 0, requests: 0, cached: 0 },
    notices: [],
    attempts: 0,
  };
  put("jobs", job.id, job);
  return job;
}
export function queueJob(jobId: string, manual = false) {
  const state = runtime(),
    job = get<Job>("jobs", jobId);
  if (!job) throw new Error("找不到分析工作");
  if (!job.files.length) throw new Error("請先上傳至少一段錄影");
  if (
    job.status === "processing" ||
    state.pending.some((j) => j.jobId === jobId)
  )
    throw new Error("工作已在執行中");
  if (job.status === "completed" || job.status === "review")
    throw new Error("此工作已完成；請直接核對結果");
  if (!manual && !process.env.OPENAI_API_KEY)
    throw new Error(
      "尚未設定 OPENAI_API_KEY；可先選擇人工核對模式，或設定 .env.local 後重啟。",
    );
  updateJob(jobId, {
    status: "queued",
    stage: "排隊中",
    error: null,
    attempts: job.attempts + 1,
  });
  state.pending.push({ jobId, manual });
  void drain();
  return get<Job>("jobs", jobId)!;
}
export async function cancelJob(jobId: string) {
  const state = runtime(),
    job = get<Job>("jobs", jobId);
  if (!job) throw new Error("找不到分析工作");
  if (["completed", "review"].includes(job.status))
    throw new Error("已完成的工作不需要取消");
  state.pending = state.pending.filter((j) => j.jobId !== jobId);
  state.controllers.get(jobId)?.abort();
  updateJob(jobId, { status: "cancelled", stage: "已取消", error: null });
  for (const file of job.files)
    if (file.path) await fs.rm(file.path, { force: true });
}
async function drain() {
  const state = runtime();
  if (state.running) return;
  state.running = true;
  try {
    while (state.pending.length) {
      const item = state.pending.shift()!;
      await processJob(item.jobId, item.manual);
    }
  } finally {
    state.running = false;
  }
}
async function processJob(jobId: string, manual: boolean) {
  const control = new AbortController(),
    signal = control.signal;
  runtime().controllers.set(jobId, control);
  const job = get<Job>("jobs", jobId)!;
  let terminal: Partial<Job> = {
    status: "failed",
    stage: "處理失敗",
    error: "分析未完成",
  };
  updateJob(jobId, { status: "processing", stage: "準備影片", progress: 0 });
  try {
    const selected: { video: string; frame: SelectedFrame }[] = [];
    for (let i = 0; i < job.files.length; i++) {
      signal.throwIfAborted();
      const file = job.files[i],
        cacheId = `frames:${jobId}:${file.id}`;
      let frames = get<SelectedFrame[]>("settings", cacheId);
      if (!frames) {
        if (
          !file.path ||
          !(await fs.access(file.path).then(
            () => true,
            () => false,
          ))
        )
          throw new Error(
            "此影片的暫存檔已清除，且尚未完成抽幀；請重新匯入原始錄影。",
          );
        updateJob(jobId, {
          stage: `抽幀 ${i + 1}／${job.files.length}：${file.name}`,
          progress: Math.round((i / job.files.length) * 35),
        });
        frames = await extractFrames(file.path, jobId, file.id, signal, (p) => {
          if (!signal.aborted)
            updateJob(jobId, {
              progress: Math.round(((i + p) / job.files.length) * 35),
            });
        });
        put("settings", cacheId, frames);
      }
      selected.push(...frames.map((frame) => ({ video: file.name, frame })));
    }
    if (!selected.length) throw new Error("未擷取到可辨識的畫面，請重新錄製");
    const snapshot = getSnapshot();
    if (!snapshot)
      updateJob(jobId, {
        notices: ["尚未載入遊戲資料；辨識結果將保持待確認。請在設定更新資料。"],
      });
    const observations = listObservations(jobId);
    for (let i = 0; i < selected.length; i++) {
      signal.throwIfAborted();
      const { video, frame } = selected[i],
        observationId = `${jobId}-${i}`;
      updateJob(jobId, {
        stage: `${manual ? "建立核對畫面" : "辨識畫面"} ${i + 1}／${selected.length}`,
        progress: 35 + Math.round((i / selected.length) * 55),
      });
      if (observations.some((o) => o.id === observationId)) continue;
      const result = manual
        ? manualObservation(frame.iv)
        : await recognize(frame.frame, snapshot, signal, (usage) => {
            const current = get<Job>("jobs", jobId)!;
            updateJob(jobId, {
              usage: {
                input: current.usage.input + usage.input,
                output: current.usage.output + usage.output,
                requests: current.usage.requests + (usage.cached ? 0 : 1),
                cached: current.usage.cached + (usage.cached ? 1 : 0),
              },
            });
          });
      const reconciled = reconcileIV(result.fields, frame.iv);
      const observation: Observation = {
        id: observationId,
        jobId,
        segment: manual ? `${frame.segment}-${i}` : frame.segment,
        frame: frame.frame,
        time: frame.time,
        video,
        fields: reconciled.fields,
        ivMeasured: frame.iv,
        issues: [
          ...frame.issues,
          ...result.issues,
          ...reconciled.issues,
          ...(!result.clear ? ["此畫面需要人工核對"] : []),
        ],
        kind: result.kind,
      };
      put("observations", observation.id, observation);
    }
    signal.throwIfAborted();
    updateJob(jobId, { stage: "配對影片與收藏庫", progress: 92 });
    const allObservations = listObservations(jobId),
      existing = listPokemon(),
      known = new Set(
        existing.flatMap((p) => p.sources.map((s) => s.observationId)),
      );
    const combined = integrateObservations(
      allObservations.filter((o) => !known.has(o.id)),
      existing,
    );
    transaction(() => {
      for (const pokemon of combined) put("pokemon", pokemon.id, pokemon);
    });
    updateJob(jobId, { stage: "計算團體戰與 PvP", progress: 97 });
    reevaluate();
    terminal = { status: "review", stage: "分析完成，等待核對", progress: 100 };
  } catch (error) {
    if (signal.aborted)
      terminal = { status: "cancelled", stage: "已取消", error: null };
    else
      terminal = {
        status: "failed",
        stage: "處理失敗",
        error: error instanceof Error ? error.message : "未知錯誤",
      };
  } finally {
    runtime().controllers.delete(jobId);
    for (const file of job.files)
      if (file.path) await fs.rm(file.path, { force: true }).catch(() => {});
    await fs
      .rm(path.join(dataDir, "uploads", jobId), {
        recursive: true,
        force: true,
      })
      .catch(() => {});
    updateJob(jobId, terminal);
  }
}
export function initializeJobs() {
  runtime();
}
