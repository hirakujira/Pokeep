import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import { emptyFields, type Analysis, type RaidResult } from "../src/lib/types";

const { api } = await import("../src/components/dashboard/api");
const { trackPending } = await import("../src/components/dashboard/track-pending");
const { DrawerAnalysis } = await import("../src/components/dashboard/drawer-analysis");

test("API 回傳非 JSON 時顯示可理解的錯誤", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html>Bad Gateway</html>", { status: 502 });
    await assert.rejects(() => api("state"), { message: "操作失敗（HTTP 502）" });
    globalThis.fetch = async () => new Response("<html>ok</html>", { status: 200 });
    await assert.rejects(() => api("state"), { message: "伺服器回應格式不正確" });
    globalThis.fetch = async () => Response.json({ error: "僅允許本機存取" }, { status: 400 });
    await assert.rejects(() => api("state"), { message: "僅允許本機存取" });
    globalThis.fetch = async () => Response.json({ ok: true });
    assert.deepEqual(await api("state"), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("輪詢在上一個請求未完成時跳過，手動重新整理照常送出", async () => {
  let calls = 0;
  const resolvers: (() => void)[] = [];
  const loader = trackPending(() => {
    calls++;
    return new Promise<void>((resolve) => resolvers.push(resolve));
  });
  const first = loader.poll();
  void loader.poll();
  assert.equal(calls, 1);
  const manual = loader.run();
  assert.equal(calls, 2);
  resolvers.forEach((resolve) => resolve());
  await Promise.all([first, manual]);
  const next = loader.poll();
  assert.equal(calls, 3);
  resolvers[2]();
  await next;
});

test("渲染團體戰比較時依排名顯示，但不改動已存的分析資料", () => {
  const names = ["", "排名一號", "排名二號", "排名三號"];
  const raid = (rank: number): RaidResult => ({
    speciesId: `raid-${rank}`,
    name: names[rank],
    type: "bug",
    rank,
    dps: rank,
    fast: "BUG_BITE",
    charge: "STRUGGLE",
    elite: [],
    targets: [],
    condition: null,
  });
  const raids = [raid(3), raid(1), raid(2)];
  const analysis: Analysis = {
    category: "invest",
    reasons: [],
    warnings: [],
    collectionKeys: [],
    leagues: [],
    raids,
    currentLevels: [],
    actions: [],
    evolutionCandy: null,
    purification: null,
    comparedWith: [],
    snapshot: null,
    evaluatedAt: "2026-10-24T00:00:00.000Z",
  };
  const html = renderToString(
    React.createElement(DrawerAnalysis, { analysis, fields: emptyFields(), moveNames: {} }),
  );
  assert.deepEqual(raids.map((r) => r.rank), [3, 1, 2]);
  const positions = names.slice(1).map((name) => html.indexOf(name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});
