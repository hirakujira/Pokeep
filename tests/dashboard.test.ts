import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  emptyFields,
  type Analysis,
  type MoveTrainingAdvice,
  type MoveTrainingStep,
  type RaidResult,
} from "../src/lib/types";
import { record } from "./fixtures";

const { api } = await import("../src/components/dashboard/api");
const { trackPending } = await import("../src/components/dashboard/track-pending");
const { DrawerAnalysis } = await import("../src/components/dashboard/drawer-analysis");
const { MoveTrainingPanel } = await import("../src/components/dashboard/move-training");

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

const analysisWith = (patch: Partial<Analysis>): Analysis => ({
  category: "invest",
  reasons: [],
  warnings: [],
  collectionKeys: [],
  leagues: [],
  raids: [],
  currentLevels: [15],
  actions: [],
  evolutionCandy: null,
  purification: null,
  comparedWith: [],
  snapshot: null,
  evaluatedAt: "2026-10-24T00:00:00.000Z",
  ...patch,
});
const trainingStep = (patch: Partial<MoveTrainingStep>): MoveTrainingStep => ({
  tm: "fast",
  from: "FURY_CUTTER",
  to: "BUG_BITE",
  odds: 1,
  blocked: false,
  note: null,
  ...patch,
});
const trainingAdvice = (patch: Partial<MoveTrainingAdvice>): MoveTrainingAdvice => ({
  purpose: "raid",
  label: "團體戰 蟲屬性 #1",
  rank: 1,
  speciesId: "caterpie",
  name: "綠毛蟲",
  status: "train",
  steps: [],
  dps: null,
  ...patch,
});

test("招式學習器總覽依每顆學習器的期望提升排序，厲害學習器沒對象時列出可直接指定的招式", () => {
  const withAdvice = (id: string, moveTraining: MoveTrainingAdvice[], category: Analysis["category"] = "invest") =>
    record(id, {}, { analysis: analysisWith({ category, moveTraining }) });
  const records = [
    // +50% at 1/2 odds expects +25% per TM; +30% for certain expects +30%.
    withAdvice("big-gain", [trainingAdvice({
      name: "大幅提升", dps: { current: 10, best: 15 }, steps: [trainingStep({ odds: 2 })],
    })]),
    withAdvice("sure-gain", [trainingAdvice({
      name: "穩定提升", dps: { current: 10, best: 13 }, steps: [trainingStep({ odds: 1 })],
    })]),
    withAdvice("pvp", [trainingAdvice({
      purpose: "pvp", label: "超級聯盟 環境 #5", rank: 5, name: "聯盟成員",
      steps: [trainingStep({ tm: "charged", from: "STRUGGLE", to: "X_SCISSOR", odds: 4 })],
    })]),
    withAdvice("evolve", [trainingAdvice({ status: "evolveFirst", name: "進化目標" })]),
    withAdvice("unverified", [trainingAdvice({
      name: "未核對個體", steps: [trainingStep({ odds: 1 })],
    })], "review"),
  ];
  const html = renderToString(React.createElement(MoveTrainingPanel, {
    records,
    moveNames: { FURY_CUTTER: "連斬", BUG_BITE: "蟲咬", STRUGGLE: "掙扎", X_SCISSOR: "十字剪" },
    onSelect: () => {},
  }));
  for (const label of ["招式學習器（一般）", "招式學習器（特殊）", "厲害招式學習器（一般）", "厲害招式學習器（特殊）"])
    assert.ok(html.includes(label), label);
  assert.ok(html.indexOf("穩定提升") < html.indexOf("大幅提升"));
  assert.ok(html.includes('aria-expanded="true"'));
  assert.equal(html.split('role="tabpanel"').length - 1, 4);
  assert.equal(html.split('aria-selected="true"').length - 1, 1);
  assert.equal(html.split('hidden=""').length - 1, 3);
  assert.ok(html.includes("/api/sprites/caterpie"));
  assert.ok(html.includes("連斬 → 蟲咬"));
  assert.ok(html.includes(">1/2<"));
  assert.ok(html.includes("必定抽中"));
  assert.ok(html.includes("想用的話，可直接指定"));
  assert.equal(html.split("聯盟成員").length - 1, 2);
  assert.ok(html.includes("另有 1 隻的培養目標是進化型"));
  assert.ok(!html.includes("未核對個體"));
});

test("個體詳情列出各用途的學習器步驟與先進化提示", () => {
  const analysis = analysisWith({
    moveTraining: [
      trainingAdvice({
        steps: [trainingStep({
          tm: "eliteCharged", from: "FRUSTRATION", to: "BUG_BUZZ", blocked: true,
          note: "遷怒平時無法用學習器移除，需等允許移除的火箭隊活動",
        })],
      }),
      trainingAdvice({ purpose: "pvp", label: "大師聯盟 環境 #3", status: "evolveFirst", name: "巴大蝶" }),
    ],
  });
  const html = renderToString(
    React.createElement(DrawerAnalysis, { analysis, fields: emptyFields(), moveNames: { BUG_BUZZ: "蟲鳴" } }),
  );
  assert.ok(html.includes("厲害招式學習器（特殊）"));
  assert.ok(html.includes("直接指定"));
  assert.ok(html.includes("遷怒平時無法用學習器移除"));
  assert.ok(html.includes("培養目標是進化後的 巴大蝶"));
});
