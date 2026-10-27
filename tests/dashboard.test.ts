import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  emptyFields,
  type Analysis,
  type Fields,
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

test("招式學習器總覽依每顆學習器的價值排序，厲害學習器沒對象時列出可直接指定的招式", () => {
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
    // PvP #28 for sure scores 28; #25 at 1/3 odds scores 75, so the sure one leads.
    withAdvice("pvp-sure", [trainingAdvice({
      purpose: "pvp", label: "大師聯盟 環境 #28", rank: 28, name: "穩定聯盟", steps: [trainingStep({ odds: 1 })],
    })]),
    withAdvice("pvp-rare", [trainingAdvice({
      purpose: "pvp", label: "大師聯盟 環境 #25", rank: 25, name: "難抽聯盟", steps: [trainingStep({ odds: 3 })],
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
  assert.ok(html.indexOf("穩定聯盟") < html.indexOf("難抽聯盟"));
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

const {
  dexEntries, formChoice, speciesWithShadow, restrictedChoice, withFixedValues, shadowState, shadowFields,
} = await import("../src/components/dashboard/species-options");
const { PokemonDrawer } = await import("../src/components/dashboard/pokemon-drawer");
const catalogSpecies = (rows: [string, number, string, string | null][]) =>
  rows.map(([id, dex, name, form]) => ({ id, dex, name, types: ["normal"], form }));
const formCatalog = {
  species: catalogSpecies([
    ["pidgey", 16, "波波", null],
    ["rattata", 19, "小拉達", null],
    ["rattata_shadow", 19, "小拉達（暗影）", null],
    ["rattata_alolan", 19, "小拉達 (Alolan)", "(Alolan)"],
    ["rattata_alolan_shadow", 19, "小拉達 (Alolan)（暗影）", "(Alolan)"],
    ["nidoran_male", 32, "尼多朗", null],
    ["nidoran_m", 32, "尼多朗", null],
    ["shellos", 422, "無殼海兔", null],
    ["giratina_altered", 487, "騎拉帝納 (Altered)", "(Altered)"],
    ["giratina_origin", 487, "騎拉帝納 (Origin)", "(Origin)"],
    ["meloetta_aria", 648, "美洛耶塔 (Aria)", "(Aria)"],
    ["rockruff", 744, "岩狗狗", null],
    ["squawkabilly", 931, "怒鸚哥", null],
    ["squawkabilly_blue", 931, "怒鸚哥（藍羽）", "藍羽"],
  ]),
  moves: [],
  visualForms: {
    422: [{ id: "west_sea", label: "西海" }, { id: "east_sea", label: "東海" }],
    744: [{ id: "normal", label: "一般" }, { id: "dusk", label: "黃昏的樣子" }],
  },
};

test("物種選單每個圖鑑編號一項，形態另列且無法判斷時為待確認", () => {
  const entries = dexEntries(formCatalog.species, formCatalog.visualForms);
  const byDex = Object.fromEntries(entries.map((e) => [e.dex, e]));
  const labels = (dex: number) => byDex[dex].options.map((o) => o.label);
  assert.deepEqual(entries.map((e) => `${e.dex} ${e.name}`),
    ["16 波波", "19 小拉達", "32 尼多朗", "422 無殼海兔", "487 騎拉帝納", "648 美洛耶塔", "744 岩狗狗", "931 怒鸚哥"]);
  assert.deepEqual(labels(16), ["一般"]);
  assert.deepEqual(labels(32), ["一般"]);
  assert.deepEqual(labels(648), ["一般"]);
  assert.deepEqual(labels(19), ["一般", "阿羅拉的樣子"]);
  assert.deepEqual(labels(487), ["待確認", "別種形態", "起源形態"]);
  assert.deepEqual(labels(422), ["待確認", "西海", "東海"]);
  assert.deepEqual(labels(744), ["待確認", "一般", "黃昏的樣子"]);
  assert.deepEqual(labels(931), ["待確認", "藍羽"]);
  assert.equal(byDex[487].options[0].speciesId, null);
  assert.equal(byDex[931].options[0].speciesId, "squawkabilly");

  const pick = (dex: number, id: string | null, form: string | null) =>
    formChoice(byDex[dex], id, form).selected;
  assert.equal(pick(19, "rattata_alolan_shadow", null).label, "阿羅拉的樣子");
  assert.equal(pick(19, "rattata", "阿羅拉").label, "一般");
  assert.equal(pick(32, "nidoran_m", null).speciesId, "nidoran_male");
  assert.equal(pick(487, null, null).label, "待確認");
  assert.equal(pick(422, "shellos", null).label, "待確認");
  assert.equal(pick(422, "shellos", "east_sea").label, "東海");
  assert.equal(pick(422, "shellos", "西海").form, "西海");
  assert.equal(pick(744, "rockruff", null).label, "待確認");
  assert.equal(pick(744, "rockruff", "normal").label, "一般");
  assert.equal(pick(648, "meloetta_aria", "歌聲形態").label, "一般");

  const unknownSea = formChoice(byDex[422], "shellos", "藍花");
  assert.equal(unknownSea.selected.label, "待確認（原始辨識「藍花」）");
  assert.equal(unknownSea.options[0], unknownSea.selected);
  assert.equal(unknownSea.selected.form, "藍花");
  assert.equal(formChoice(byDex[16], "pidgey", "普通").selected.label, "一般");
  assert.equal(formChoice(byDex[16], "pidgey", "放鬆模式").selected.label, "一般（原始辨識「放鬆模式」）");

  const ids = new Set(formCatalog.species.map((s) => s.id));
  assert.equal(speciesWithShadow("rattata_alolan", true, ids), "rattata_alolan_shadow");
  assert.equal(speciesWithShadow("rattata_shadow", false, ids), "rattata");
  assert.equal(speciesWithShadow("pidgey", true, ids), "pidgey");
  assert.equal(speciesWithShadow("rattata_shadow", null, ids), "rattata_shadow");
});

test("詳細資料面板以圖鑑編號與形態兩個選單顯示目前物種", () => {
  const html = renderToString(React.createElement(PokemonDrawer, {
    pokemon: record("sea", { name: "無殼海兔", speciesId: "shellos", form: "east_sea" }),
    records: [],
    catalog: formCatalog,
    error: "",
    onClose: () => {},
    onSave: async () => null,
    onMerge: async () => {},
    busy: false,
  }));
  assert.match(html, /<option value="422" selected="">#422 無殼海兔<\/option>/);
  assert.match(html, /<option value="east_sea" selected="">東海<\/option>/);
  assert.match(html, /<option value="">待確認<\/option>/);
  assert.doesNotMatch(html, /暗影）<\/option>/);
});

test("性別與暗影依物種限制選項，只剩一個值時固定並停用；暗影與淨化合併為一個選單", () => {
  const catalog = {
    ...formCatalog,
    species: [
      { id: "pidgey", dex: 16, name: "波波", types: ["normal"], form: null, genders: ["male" as const, "female" as const] },
      { id: "tauros", dex: 128, name: "肯泰羅", types: ["normal"], form: null, genders: ["male" as const] },
      { id: "magnemite", dex: 81, name: "小磁怪", types: ["electric"], form: null, genders: ["genderless" as const] },
      { id: "magnemite_shadow", dex: 81, name: "小磁怪（暗影）", types: ["electric"], form: null, genders: ["genderless" as const] },
    ],
  };
  const byId = new Map(catalog.species.map((s) => [s.id, s]));
  const fixed = (speciesId: string, patch: Partial<Fields> = {}) => {
    const f = withFixedValues({ ...emptyFields(), speciesId, ...patch }, byId);
    return [f.gender, f.shadow, f.purified];
  };
  assert.deepEqual(fixed("tauros"), ["male", false, false]);
  assert.deepEqual(fixed("magnemite"), ["genderless", null, null]);
  assert.deepEqual(fixed("magnemite", { shadow: false }), ["genderless", false, null]);
  assert.deepEqual(fixed("magnemite", { shadow: true }), ["genderless", true, false]);
  assert.deepEqual(fixed("pidgey"), [null, false, false]);
  assert.deepEqual(fixed("tauros", { gender: "female", shadow: true }), ["female", true, false]);
  assert.deepEqual(
    [[null, null], [false, null], [false, false], [true, false], [false, true]]
      .map(([shadow, purified]) => shadowState({ shadow, purified })),
    [null, null, "none", "shadow", "purified"],
  );
  assert.deepEqual(shadowFields("purified"), { shadow: false, purified: true });
  assert.deepEqual(shadowFields(null), { shadow: null, purified: null });
  assert.deepEqual(restrictedChoice(["male", "female"], ["male"], "female"),
    { options: [null, "male", "female"], value: "female", fixed: false });
  assert.deepEqual(restrictedChoice(["male", "female", "genderless"], undefined, null).options,
    [null, "male", "female", "genderless"]);

  const render = (speciesId: string, patch: Partial<Fields> = {}) => renderToString(React.createElement(PokemonDrawer, {
    pokemon: record(speciesId, { speciesId, gender: null, shadow: null, purified: null, ...patch }),
    records: [],
    catalog,
    error: "",
    onClose: () => {},
    onSave: async () => null,
    onMerge: async () => {},
    busy: false,
  }));
  const select = (html: string, label: string) =>
    html.match(new RegExp(`<span>${label}(?:(?!</label>).)*?(<select[^>]*>.*?</select>)`))?.[1] ?? "";
  const tauros = render("tauros");
  assert.match(select(tauros, "性別"), /^<select disabled="">/);
  assert.equal(select(tauros, "性別").match(/<option/g)?.length, 1);
  assert.match(select(tauros, "性別"), /雄性/);
  assert.match(select(tauros, "暗影"), /^<select disabled=""><option value="none" selected="">無暗影形態<\/option><\/select>$/);
  assert.doesNotMatch(tauros, /<span>淨化</);
  const pidgey = select(render("pidgey"), "性別");
  assert.doesNotMatch(pidgey, /disabled|無性別/);
  assert.match(pidgey, /雌性/);
  const magnemite = render("magnemite");
  assert.match(select(magnemite, "性別"), /^<select disabled=""><option value="genderless" selected="">無性別<\/option><\/select>$/);
  assert.doesNotMatch(select(magnemite, "暗影"), /disabled/);
  assert.deepEqual([...select(magnemite, "暗影").matchAll(/>([^<>]+)<\/option>/g)].map((m) => m[1]),
    ["未確認", "無暗影形態", "暗影", "暗影 - 已淨化"]);
  assert.match(select(render("magnemite", { shadow: false, purified: true }), "暗影"),
    /<option value="purified" selected="">暗影 - 已淨化<\/option>/);
});
