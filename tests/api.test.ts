import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";
import { fixture, record } from "./fixtures";
import type { Pokemon } from "../src/lib/types";
import type { TransferBatch } from "../src/lib/iphone-types";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pogo-api-test-"));
(globalThis as typeof globalThis & { __POGO_TEST_DATA_DIR__?: string }).__POGO_TEST_DATA_DIR__ = temp;
const route = await import("../src/app/api/[...path]/route");
const store = await import("../src/lib/store");
after(() => {
  store.db().close();
  fs.rmSync(temp, { recursive: true, force: true });
});
async function request(
  url: string,
  method = "GET",
  data?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const headers = {
    host: "127.0.0.1:3000",
    "x-pogo-local": "1",
    ...extraHeaders,
  };
  const req = new NextRequest(`http://127.0.0.1:3000/api/${url}`, {
    method,
    headers,
    body:
      data instanceof Uint8Array
        ? new Uint8Array(data).buffer
        : data
          ? JSON.stringify(data)
          : undefined,
  });
  return route[method as "GET" | "POST" | "PATCH" | "PUT"](req, {
    params: Promise.resolve({ path: url.split("?")[0].split("/") }),
  });
}
test("拒絕跨網站寫入及非本機Host", async () => {
  assert.equal(
    (
      await request(
        "iphone/prepare",
        "POST",
        {},
        { origin: "https://example.org" },
      )
    ).status,
    400,
  );
  assert.equal(
    (await request("state", "GET", undefined, { host: "remote.example" }))
      .status,
    400,
  );
});
test("正式Next服務內部hostname與瀏覽器不同時，同源寫入仍可儲存", async () => {
  const req = new NextRequest("http://localhost:3000/api/iphone/prepare", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "x-pogo-local": "1",
    },
    body: JSON.stringify({}),
  });
  const response = await route.POST(req, {
    params: Promise.resolve({ path: ["iphone", "prepare"] }),
  });
  assert.equal(response.status, 200);
});
test("手機 API 只建立持久化掃描工作，暫停與停止不操作裝置", async () => {
  store.put("settings", "runtime-config", { apiKey: "test-only-key" });
  store.put("settings", "iphone-worker", {
    updatedAt: new Date().toISOString(),
    ready: false,
    message: "等待連線",
    version: "test",
  });
  const created = await request("scans", "POST", { scope: "results" });
  assert.equal(created.status, 201);
  const scan = await created.json();
  assert.equal(scan.status, "queued");
  assert.equal(
    (await request(`scans/${scan.id}/control`, "POST", { action: "pause" }))
      .status,
    200,
  );
  assert.equal(
    store.get<{ status: string }>("scans", scan.id)?.status,
    "paused",
  );
  assert.equal(
    (await request(`scans/${scan.id}/control`, "POST", { action: "resume" }))
      .status,
    200,
  );
  assert.equal(
    (await request(`scans/${scan.id}/control`, "POST", { action: "stop" }))
      .status,
    200,
  );
  assert.equal(
    store.get<{ status: string }>("scans", scan.id)?.status,
    "stopped",
  );
  assert.equal((await request("iphone")).status, 200);
  store.remove("settings", "runtime-config");
});

test("逐隻放生每次只授權一個候選，重複請求與整批執行被拒絕", async () => {
  const { transferSignature } = await import("../src/lib/iphone-safety");
  const snapshot = fixture();
  store.saveSnapshot(snapshot);
  const stamp = new Date().toISOString();
  const analysis = {
    category: "transfer",
    currentLevels: [15],
  } as Pokemon["analysis"];
  const first = record("one-by-one-1", { favorite: false }, { analysis });
  const second = record("one-by-one-2", { favorite: false }, { analysis });
  store.put("pokemon", first.id, first);
  store.put("pokemon", second.id, second);
  const batch: TransferBatch = {
    id: "one-by-one-api",
    scanId: "one-by-one-scan",
    createdAt: stamp,
    updatedAt: stamp,
    status: "draft",
    mode: "single",
    selectedPokemonId: null,
    signature: "",
    entries: [first, second].map((p) => ({
      pokemonId: p.id,
      status: "pending" as const,
      reason: null,
    })),
    error: null,
    approvedAt: null,
  };
  batch.signature = transferSignature(
    batch,
    store.listPokemon(),
    snapshot,
    store.getSettings(),
  );
  store.put("transfer_batches", batch.id, batch);
  assert.equal(
    (await request(`transfers/${batch.id}/approve`, "POST", {})).status,
    400,
  );
  store.put("transfer_batches", "legacy-bulk", {
    ...batch,
    id: "legacy-bulk",
    mode: "bulk",
  });
  assert.equal(
    (await request("transfers/legacy-bulk/approve", "POST", {})).status,
    400,
  );
  store.remove("transfer_batches", "legacy-bulk");
  assert.equal(
    (
      await request(`transfers/${batch.id}/execute-one`, "POST", {
        pokemonId: first.id,
      })
    ).status,
    200,
  );
  assert.equal(
    store.get<TransferBatch>("transfer_batches", batch.id)?.selectedPokemonId,
    first.id,
  );
  assert.equal(
    (
      await request(`transfers/${batch.id}/execute-one`, "POST", {
        pokemonId: second.id,
      })
    ).status,
    400,
  );
  const approved = store.get<TransferBatch>("transfer_batches", batch.id)!;
  const confirmed: TransferBatch = {
    ...approved,
    status: "draft",
    selectedPokemonId: null,
    approvedAt: null,
    entries: [
      { ...approved.entries[0], status: "confirmed", confirmedAt: stamp },
      approved.entries[1],
    ],
  };
  store.put("pokemon", first.id, { ...first, owned: false });
  confirmed.signature = transferSignature(
    confirmed,
    store.listPokemon(),
    snapshot,
    store.getSettings(),
  );
  store.put("transfer_batches", batch.id, confirmed);
  assert.equal(
    (
      await request(`transfers/${batch.id}/execute-one`, "POST", {
        pokemonId: first.id,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`transfers/${batch.id}/execute-one`, "POST", {
        pokemonId: second.id,
      })
    ).status,
    200,
  );
  const latest = store.get<TransferBatch>("transfer_batches", batch.id)!;
  store.put("transfer_batches", batch.id, {
    ...latest,
    status: "stopped",
    selectedPokemonId: null,
    approvedAt: null,
  });
  store.remove("pokemon", first.id);
  store.remove("pokemon", second.id);
  store.remove("transfer_batches", batch.id);
});
test("清倉結果按一次放生即建立並授權唯一候選", async () => {
  store.saveSnapshot(fixture());
  const catalog = await (await request("species")).json();
  assert.equal(catalog.species.find((row: { id: string }) => row.id === "caterpie")?.dex, 10);
  const stamp = new Date().toISOString();
  const pokemon = record("direct-release", { favorite: false }, {
    analysis: { category: "transfer", currentLevels: [15] } as Pokemon["analysis"],
  });
  const scanId = "direct-release-scan";
  store.put("pokemon", pokemon.id, pokemon);
  store.put("scans", scanId, {
    id: scanId, scope: "all", status: "completed", phase: "analysis",
    stage: "完成", createdAt: stamp, updatedAt: stamp, scanned: 1,
    analyzed: 1, review: 0, expected: 1, sort: null, currentFrame: null,
    lastFingerprint: null,
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null, checkpointRequired: false, iphoneUseVersion: "test",
  });
  store.put("scan_items", "direct-release-item", {
    id: "direct-release-item", scanId, position: 0, pokemonId: pokemon.id,
    fields: pokemon.fields, issues: [], protectionClear: true,
    frame: "", appraisalFrame: null, fingerprint: "", capturedAt: stamp,
  });
  const response = await request("transfers/execute-one", "POST", {
    pokemonId: pokemon.id,
  });
  assert.equal(response.status, 200);
  const batch = (await response.json()) as TransferBatch;
  assert.equal(batch.status, "approved");
  assert.equal(batch.selectedPokemonId, pokemon.id);
  assert.equal(batch.entries.filter((entry) => entry.status === "pending").length, 1);
  assert.equal(
    (await request("transfers/execute-one", "POST", { pokemonId: pokemon.id })).status,
    400,
  );
  store.remove("transfer_batches", batch.id);
  store.remove("scan_items", "direct-release-item");
  store.remove("scans", scanId);
  store.remove("pokemon", pokemon.id);
});
test("清倉結果勾選批次只授權明列個體，拒絕重複與受保護名單", async () => {
  store.saveSnapshot(fixture());
  const stamp = new Date().toISOString();
  const analysis = { category: "transfer", currentLevels: [15] } as Pokemon["analysis"];
  const first = record("bulk-first", { cp: 179, favorite: false }, { analysis });
  const second = record("bulk-second", { cp: 180, favorite: false }, { analysis, locked: true });
  const scanId = "bulk-direct-scan";
  store.put("pokemon", first.id, first);
  store.put("pokemon", second.id, second);
  store.put("scans", scanId, {
    id: scanId, scope: "all", status: "completed", phase: "analysis",
    stage: "完成", createdAt: stamp, updatedAt: stamp, scanned: 2,
    analyzed: 2, review: 0, expected: 2, sort: null, currentFrame: null,
    lastFingerprint: null, apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null, checkpointRequired: false, iphoneUseVersion: "test",
  });
  for (const [position, pokemon] of [first, second].entries())
    store.put("scan_items", `bulk-direct-item-${position}`, {
      id: `bulk-direct-item-${position}`, scanId, position, pokemonId: pokemon.id,
      fields: pokemon.fields, issues: [], protectionClear: true,
      frame: "", appraisalFrame: null, fingerprint: "", capturedAt: stamp,
    });
  const ids = [first.id, second.id];
  assert.equal((await request("transfers/execute-many", "POST", { pokemonIds: [first.id, first.id] })).status, 400);
  assert.equal((await request("transfers/execute-many", "POST", { pokemonIds: ids })).status, 400);
  store.put("pokemon", second.id, { ...second, locked: false });
  assert.equal((await request("transfers/execute-many", "POST", {
    pokemonIds: ids, searchExclusions: ["background", "lucky", "shiny", "costume"],
  })).status, 400);
  assert.equal((await request("transfers/execute-many", "POST", {
    pokemonIds: ids, searchExclusions: ["background", "background"],
  })).status, 400);
  const response = await request("transfers/execute-many", "POST", {
    pokemonIds: ids, searchExclusions: ["background", "lucky", "shiny"],
  });
  assert.equal(response.status, 200);
  const batch = (await response.json()) as TransferBatch;
  assert.equal(batch.mode, "bulk");
  assert.equal(batch.status, "approved");
  assert.deepEqual(batch.searchExclusions, ["background", "lucky", "shiny"]);
  assert.deepEqual(batch.entries.map((entry) => entry.pokemonId), ids);
  assert.equal((await request("transfers/execute-many", "POST", { pokemonIds: ids })).status, 400);
  store.remove("transfer_batches", batch.id);
  for (const position of [0, 1]) store.remove("scan_items", `bulk-direct-item-${position}`);
  store.remove("scans", scanId);
  store.remove("pokemon", first.id);
  store.remove("pokemon", second.id);
});

test("暫停批次按繼續只重試搜尋前失敗與未開始個體，拒絕重複請求及不明結果", async () => {
  const { transferSignature } = await import("../src/lib/iphone-safety");
  const snapshot = fixture();
  store.saveSnapshot(snapshot);
  const stamp = new Date().toISOString();
  const analysis = { category: "transfer", currentLevels: [15] } as Pokemon["analysis"];
  const done = record("resume-done", { favorite: false }, { owned: false, analysis });
  const retry = record("resume-retry", { favorite: false, cp: 180 }, { analysis });
  const untouched = record("resume-untouched", { favorite: false, cp: 181 }, { analysis });
  for (const pokemon of [done, retry, untouched])
    store.put("pokemon", pokemon.id, pokemon);
  const batch: TransferBatch = {
    id: "resume-api-batch",
    scanId: "resume-api-scan",
    createdAt: stamp,
    updatedAt: stamp,
    status: "paused",
    mode: "bulk",
    selectedPokemonId: null,
    signature: "",
    entries: [
      { pokemonId: done.id, status: "submitted", reason: "已送出", submittedAt: stamp },
      { pokemonId: retry.id, status: "skipped", reason: "搜尋欄未確認" },
      { pokemonId: untouched.id, status: "pending", reason: null },
    ],
    error: "搜尋欄未確認",
    approvedAt: null,
  };
  batch.signature = transferSignature(batch, store.listPokemon(), snapshot, store.getSettings());
  store.put("transfer_batches", batch.id, batch);
  const response = await request(`transfers/${batch.id}/resume`, "POST");
  assert.equal(response.status, 200);
  const resumed = await response.json() as TransferBatch;
  assert.equal(resumed.status, "approved");
  assert.deepEqual(resumed.entries.map((entry) => entry.status), ["submitted", "pending", "pending"]);
  assert.equal((await request(`transfers/${batch.id}/resume`, "POST")).status, 400);
  store.put("transfer_batches", batch.id, {
    ...batch,
    entries: [batch.entries[0], { ...batch.entries[1], status: "uncertain" }, batch.entries[2]],
  });
  assert.equal((await request(`transfers/${batch.id}/resume`, "POST")).status, 400);
  const dialogError = "不是一般放生確認畫面，或出現額外警告；尚未放生";
  const single: TransferBatch = {
    ...batch,
    mode: "single",
    entries: [batch.entries[0], {
      ...batch.entries[1], reason: dialogError,
      preparedAt: stamp, evidence: "search-cp.jpg",
    }],
    error: dialogError,
  };
  single.signature = transferSignature(single, store.listPokemon(), snapshot, store.getSettings());
  store.put("transfer_batches", batch.id, single);
  const retried = await request(`transfers/${batch.id}/resume`, "POST");
  assert.equal(retried.status, 200);
  const retriedBatch = await retried.json() as TransferBatch;
  assert.equal(retriedBatch.selectedPokemonId, retry.id);
  assert.equal(retriedBatch.entries[1].status, "pending");
  assert.equal(retriedBatch.entries[1].preparedAt, undefined);
  store.put("transfer_batches", batch.id, { ...single, signature: "stale" });
  assert.equal((await request(`transfers/${batch.id}/resume`, "POST")).status, 400);
  for (const pokemon of [done, retry, untouched]) store.remove("pokemon", pokemon.id);
  store.remove("transfer_batches", batch.id);
});
test("暫停批次可跳過當前失敗個體並續跑，已送出及結果不明者不得跳過", async () => {
  const { transferSignature } = await import("../src/lib/iphone-safety");
  const snapshot = fixture();
  store.saveSnapshot(snapshot);
  const stamp = new Date().toISOString();
  const analysis = { category: "transfer", currentLevels: [15] } as Pokemon["analysis"];
  const failed = record("skip-failed", { favorite: false, cp: 180 }, { analysis });
  const next = record("skip-next", { favorite: false, cp: 181 }, { analysis });
  const noLongerEligible = record("skip-excluded", { favorite: false, cp: 182 }, {
    analysis: { category: "review", currentLevels: [15] } as Pokemon["analysis"],
  });
  for (const pokemon of [failed, next, noLongerEligible]) store.put("pokemon", pokemon.id, pokemon);
  const batch: TransferBatch = {
    id: "skip-current-api-batch",
    scanId: "skip-current-api-scan",
    createdAt: stamp,
    updatedAt: stamp,
    status: "paused",
    mode: "bulk",
    selectedPokemonId: null,
    signature: "",
    entries: [
      { pokemonId: failed.id, status: "skipped", reason: "確認畫面無法辨識", preparedAt: stamp, evidence: "frame.png" },
      { pokemonId: next.id, status: "pending", reason: null },
      { pokemonId: noLongerEligible.id, status: "pending", reason: null },
    ],
    error: "確認畫面無法辨識",
    approvedAt: null,
  };
  batch.signature = transferSignature(batch, store.listPokemon(), snapshot, store.getSettings());
  store.put("transfer_batches", batch.id, batch);
  const response = await request(`transfers/${batch.id}/skip-current`, "POST");
  assert.equal(response.status, 200);
  const skipped = await response.json() as TransferBatch;
  assert.equal(skipped.status, "approved");
  assert.deepEqual(skipped.entries.map((entry) => entry.status), ["skipped", "pending", "skipped"]);
  assert.match(skipped.entries[0].reason || "", /使用者選擇跳過/);
  assert.match(skipped.entries[2].reason || "", /已不符合放生條件/);
  assert.equal(store.get<Pokemon>("pokemon", failed.id)?.owned, true);
  assert.equal((await request(`transfers/${batch.id}/skip-current`, "POST")).status, 400);
  store.put("transfer_batches", batch.id, {
    ...batch,
    entries: [{ ...batch.entries[0], status: "uncertain", sentAt: stamp }, batch.entries[1]],
  });
  assert.equal((await request(`transfers/${batch.id}/skip-current`, "POST")).status, 400);
  store.put("transfer_batches", batch.id, {
    ...batch,
    entries: [{ ...batch.entries[0], sentAt: stamp }, batch.entries[1]],
  });
  assert.equal((await request(`transfers/${batch.id}/skip-current`, "POST")).status, 400);
  for (const pokemon of [failed, next, noLongerEligible]) store.remove("pokemon", pokemon.id);
  store.remove("transfer_batches", batch.id);
});
test("總數未知時須先保存逐隻截圖，再由使用者確認開始解析", async () => {
  const stamp = new Date().toISOString();
  const scanId = "capture-checkpoint-api";
  store.put("scans", scanId, {
    id: scanId,
    scope: "results",
    status: "paused",
    phase: "capture",
    analyzed: 0,
    stage: "確認範圍",
    createdAt: stamp,
    updatedAt: stamp,
    scanned: 1,
    review: 0,
    expected: null,
    sort: null,
    currentFrame: null,
    lastFingerprint: null,
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null,
    checkpointRequired: true,
    iphoneUseVersion: null,
  });
  assert.equal(
    (await request(`scans/${scanId}/control`, "POST", { action: "finish" }))
      .status,
    400,
  );
  store.put("scan_items", "capture-only-api", {
    id: "capture-only-api",
    scanId,
    position: 0,
    frame: `${scanId}/top.jpg`,
    movesFrame: `${scanId}/moves.jpg`,
    appraisalFrame: `${scanId}/iv.jpg`,
    measuredIV: [14, 12, 13],
    fingerprint: "capture-proof",
    pokemonId: null,
    fields: null,
    issues: [],
    protectionClear: false,
    capturedAt: stamp,
  });
  const response = await request(`scans/${scanId}/control`, "POST", {
    action: "finish",
  });
  assert.equal(response.status, 200);
  const queued = await response.json();
  assert.equal(queued.phase, "analysis");
  assert.equal(queued.status, "queued");
  assert.equal(queued.analyzed, 0);
  assert.equal(store.get("pokemon", "capture-only-api"), null);
  store.put("scans", scanId, { ...queued, status: "stopped" });
});
test("重來會清除未完成掃描及其個體和截圖，保留其他收藏", async () => {
  const stamp = new Date().toISOString();
  const scanId = "discard-api-scan";
  const scan = {
    id: scanId,
    scope: "all",
    status: "paused",
    phase: "capture",
    analyzed: 1,
    stage: "已暫停",
    createdAt: stamp,
    updatedAt: stamp,
    scanned: 1,
    review: 1,
    expected: 725,
    sort: null,
    currentFrame: `${scanId}/top.jpg`,
    lastFingerprint: "static",
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null,
    checkpointRequired: false,
    iphoneUseVersion: null,
  };
  store.put("scans", scanId, scan);
  store.put("scans", "completed-history", {
    ...scan,
    id: "completed-history",
    status: "completed",
    scanned: 0,
    analyzed: 0,
    expected: 0,
    currentFrame: null,
  });
  store.put("scan_items", "discard-item", {
    id: "discard-item",
    scanId,
    position: 0,
    frame: `${scanId}/top.jpg`,
    movesFrame: `${scanId}/moves.jpg`,
    appraisalFrame: `${scanId}/iv.jpg`,
    measuredIV: [14, 12, 13],
    fingerprint: "static",
    pokemonId: "discard-pokemon",
    fields: record("discard-pokemon").fields,
    issues: [],
    protectionClear: false,
    capturedAt: stamp,
  });
  store.put("pokemon", "discard-pokemon", record("discard-pokemon", {}, {
    jobId: scanId,
    sources: [{
      observationId: "discard-observation",
      frame: `${scanId}/top.jpg`,
      time: 0,
      video: "iPhone Use",
      fields: [],
      source: "iphone",
      scanItemId: "discard-item",
      capturedAt: stamp,
    }],
  }));
  store.put("pokemon", "keep-peer", record("keep-peer", {}, {
    candidates: ["discard-pokemon"],
  }));
  store.put("observations", "discard-observation", {
    id: "discard-observation",
    jobId: scanId,
    segment: "discard-item",
    frame: `${scanId}/top.jpg`,
    time: 0,
    video: "iPhone Use",
    fields: record("discard-pokemon").fields,
    issues: [],
    ivMeasured: null,
    kind: "details",
    source: "iphone",
    scanItemId: "discard-item",
    capturedAt: stamp,
  });
  const frames = path.join(temp, "frames", scanId);
  fs.mkdirSync(frames, { recursive: true });
  fs.writeFileSync(path.join(frames, "top.jpg"), "test");
  store.put("settings", "iphone-operation", { scanId, updatedAt: stamp });
  assert.equal((await request("scans/discard", "POST")).status, 400);
  store.put("settings", "iphone-operation", null);
  const response = await request("scans/discard", "POST");
  assert.equal(response.status, 200);
  assert.equal(store.get("scans", scanId), null);
  assert.equal(store.get("scan_items", "discard-item"), null);
  assert.equal(store.get("pokemon", "discard-pokemon"), null);
  assert.equal(store.get("observations", "discard-observation"), null);
  assert.equal(fs.existsSync(frames), false);
  assert.ok(store.get("scans", "completed-history"));
  assert.ok(store.get("pokemon", "keep-peer"));
  assert.deepEqual(store.get<Pokemon>("pokemon", "keep-peer")?.candidates, []);
});
test("狀態介面只回傳 API 是否設定，不暴露 key", async () => {
  process.env.OPENAI_API_KEY = "ignored-environment-key";
  assert.equal((await (await request("state")).json()).apiConfigured, false);
  assert.equal((await request("runtime-settings", "PATCH", { apiKey: "synthetic-never-a-real-secret" })).status, 200);
  const response = await request("state"),
    text = await response.text();
  assert.ok(text.includes('"apiConfigured":true'));
  assert.ok(!text.includes("synthetic-never-a-real-secret"));
  const changed = await request("runtime-settings", "PATCH", {
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    analysisConcurrency: 8,
  });
  assert.equal(changed.status, 200);
  assert.ok(!(await changed.text()).includes("synthetic-never-a-real-secret"));
  assert.equal((await (await request("state")).json()).runtime.model, "local-model");
  assert.equal((await (await request("state")).json()).runtime.apiConfigured, true);
  assert.equal((await request("runtime-settings", "PATCH", { baseUrl: "file:///tmp/secret" })).status, 400);
  const { exportBackup } = await import("../src/lib/backup");
  assert.ok(!JSON.stringify(await exportBackup()).includes("synthetic-never-a-real-secret"));
  assert.equal((await request("runtime-settings", "PATCH", { clearApiKey: true })).status, 200);
  assert.equal((await (await request("state")).json()).apiConfigured, false);
  delete process.env.OPENAI_API_KEY;
  store.remove("settings", "runtime-config");
});
test("錄影建立與上傳介面已停用", async () => {
  assert.equal((await request("jobs", "POST", { name: "舊入口" })).status, 404);
  assert.equal((await request("jobs/legacy/files?name=a.mp4", "PUT", new Uint8Array())).status, 404);
  assert.equal((await request("jobs/legacy/start", "POST", {})).status, 404);
});
test("人工修正會持久保存、重新評估且可標記放生再恢復", async () => {
  store.saveSnapshot(fixture());
  store.put("pokemon", "edited", record("edited"));
  let response = await request("pokemon/edited", "PATCH", {
    fields: { name: "手動名稱" },
    verified: true,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).overrides.name, "手動名稱");
  response = await request("pokemon/edited", "PATCH", {
    maxStatus: "dynamax",
    verified: true,
  });
  assert.equal(response.status, 200);
  assert.equal(store.get<Pokemon>("pokemon", "edited")?.maxStatus, "dynamax");
  response = await request("pokemon/edited", "PATCH", {
    evolutionSilhouette: "unavailable",
    verified: true,
  });
  assert.equal(response.status, 200);
  assert.equal(store.get<Pokemon>("pokemon", "edited")?.evolutionSilhouette, "unavailable");
  response = await request("pokemon/edited", "PATCH", {
    evolutionSilhouette: "unknown-branch",
    verified: true,
  });
  assert.equal(response.status, 200);
  assert.equal(store.get<Pokemon>("pokemon", "edited")?.evolutionSilhouette, "unknown-branch");
  await request("pokemon/edited", "PATCH", { owned: false });
  assert.equal(store.get<Pokemon>("pokemon", "edited")?.owned, false);
  await request("pokemon/edited", "PATCH", { owned: true });
  assert.equal(store.get<Pokemon>("pokemon", "edited")?.owned, true);
});
test("人工選擇合併保留鎖定與修正，不能將自己合併", async () => {
  store.put(
    "pokemon",
    "target",
    record("target", {}, { overrides: { name: "修正名稱" } }),
  );
  store.put("pokemon", "source", record("source", {}, { locked: true }));
  assert.equal(
    (await request("merge", "POST", { target: "target", source: "source" }))
      .status,
    200,
  );
  const merged = store.get<Pokemon>("pokemon", "target")!;
  assert.equal(merged.overrides.name, "修正名稱");
  assert.equal(merged.locked, true);
  assert.equal(merged.verified, false);
  assert.equal(merged.maxStatus, "none");
  assert.equal(store.get("pokemon", "source"), null);
  assert.equal(
    (await request("merge", "POST", { target: "target", source: "target" }))
      .status,
    400,
  );
});
test("無效IV、暗影與淨化矛盾、錯誤備份都被拒絕", async () => {
  assert.equal(
    (await request("pokemon/edited", "PATCH", { fields: { ivAtk: 16 } }))
      .status,
    400,
  );
  assert.equal(
    (
      await request("pokemon/edited", "PATCH", {
        fields: { shadow: true, purified: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("import", "POST", { format: "wrong" })).status,
    400,
  );
});
test("清除全部寶可夢需明確確認，保留連線設定與遊戲資料", async () => {
  const scan = {
    id: "clear-test-scan",
    status: "queued",
    updatedAt: new Date().toISOString(),
  };
  store.put("scans", scan.id, scan);
  assert.equal((await request("pokemon/clear-all", "POST", { confirmation: "清除全部寶可夢" })).status, 400);
  store.remove("scans", scan.id);
  assert.equal((await request("pokemon/clear-all", "POST", { confirmation: "確認" })).status, 400);
  store.put("settings", "iphone-operation", { updatedAt: new Date().toISOString() });
  assert.equal((await request("pokemon/clear-all", "POST", { confirmation: "清除全部寶可夢" })).status, 400);
  store.remove("settings", "iphone-operation");

  store.put("settings", "runtime-config", { apiKey: "test-only-secret", model: "test-model" });
  store.put("pokemon", "to-clear", record("to-clear"));
  store.put("transfer_batches", "clear-history", { id: "clear-history", status: "completed", entries: [] });
  const frame = path.join(temp, "frames", "clear-test", "one.jpg");
  fs.mkdirSync(path.dirname(frame), { recursive: true });
  fs.writeFileSync(frame, "fixture");
  const response = await request("pokemon/clear-all", "POST", { confirmation: "清除全部寶可夢" });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).removedPokemon > 0);
  assert.equal(store.listPokemon().length, 0);
  assert.equal(store.all("scans").length, 0);
  assert.equal(store.all("transfer_batches").length, 0);
  assert.equal(fs.existsSync(path.join(temp, "frames")), false);
  assert.equal(store.getSnapshot()?.version, "fixture-1");
  assert.equal((store.get<{ apiKey: string }>("settings", "runtime-config"))?.apiKey, "test-only-secret");
});
