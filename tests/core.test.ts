import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fixture, record, species, settings } from "./fixtures";
import { emptyFields, settingsSchema, type Observation } from "../src/lib/types";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pogo-test-"));
(globalThis as typeof globalThis & { __POGO_TEST_DATA_DIR__?: string }).__POGO_TEST_DATA_DIR__ = temp;
const {
  combatPower,
  hitPoints,
  inferLevels,
  powerCost,
  rankIV,
  evolutionPaths,
  evaluateCollection,
  cycleDps,
} = await import("../src/lib/evaluate");
const { matching, integrateObservations } = await import("../src/lib/matching");
const { reconcileIV, recognize } = await import("../src/lib/vision");
const { measureIV } = await import("../src/lib/iv");
const { evolutionSilhouette } = await import("../src/lib/evolution-silhouette");
const { maxStatusFromOcr } = await import("../src/lib/max-status");
const { moveName, localizeMoveText } = await import("../src/lib/move-names");
const { typeName } = await import("../src/lib/type-names");
const { transferExclusion } = await import("../src/lib/iphone-safety");
const store = await import("../src/lib/store");
const { exportBackup, importBackup, exportCsv, validFrame } =
  await import("../src/lib/backup");
after(() => {
  store.db().close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("招式 ID、舊分析文字和手動輸入都能顯示繁體中文", () => {
  const names = {
    FUTURESIGHT: "預知未來",
    PSYCHO_CUT: "精神利刃",
    CHILLING_WATER: "Chilling Water",
  };
  assert.equal(moveName("FUTURE_SIGHT", names), "預知未來");
  assert.equal(moveName("AEGISLASH_CHARGE_PSYCHO_CUT", names), "精神利刃");
  assert.equal(moveName("CHILLING_WATER", names), "冷水");
  assert.equal(moveName("PYROBALL", names), "火焰球");
  assert.equal(moveName("預知未來", names), "預知未來");
  assert.equal(
    localizeMoveText("招式 AEGISLASH_CHARGE_PSYCHO_CUT、Chilling Water", names),
    "招式 精神利刃、冷水",
  );
});

test("團體戰每屬性可保留二軍，設定與分析都接受 12 個名額", () => {
  const snapshot = fixture();
  snapshot.version = "raid-slots-fixture";
  snapshot.moves.STRUGGLE.type = "bug";
  const records = Array.from({ length: 13 }, (_, index) =>
    record(`raid-${index}`),
  );
  const retained = (raidSlots: number) => evaluateCollection(
    records, snapshot, settingsSchema.parse({ ...settings, raidSlots }),
  ).filter((pokemon) => pokemon.analysis?.category === "invest").length;
  assert.equal(retained(6), 6);
  assert.equal(retained(12), 12);
  assert.equal(retained(24), 13);
  assert.throws(() => settingsSchema.parse({ ...settings, raidSlots: 25 }));
});

test("保留理由明示 PvP、團體戰，且屬性使用中文", () => {
  const snapshot = fixture();
  snapshot.version = "localized-reasons-fixture";
  snapshot.rankings["10000"] = [{ speciesId: "caterpie", score: 100, moves: [] }];
  snapshot.moves.STRUGGLE.type = "bug";
  const [pokemon] = evaluateCollection([record("pvp-raid")], snapshot, settings);
  const reasons = pokemon.analysis?.reasons.join(" ") || "";
  assert.match(reasons, /入選 PvP 大師聯盟：環境排名 #1／IV 排名 #/);
  assert.match(reasons, /入選團體戰 蟲屬性隊伍：基準物種輸出排名 #1/);
  assert.equal(typeName("psychic"), "超能力");
});

test("每種物種至少 40/45 的最高 IV 個體保留一隻", () => {
  const snapshot = fixture();
  snapshot.version = "high-iv-representatives-fixture";
  snapshot.species.other = species("other");
  const make = (id: string, speciesId: string, iv: number[]) =>
    record(id, {
      speciesId, favorite: false,
      ivAtk: iv[0], ivDef: iv[1], ivSta: iv[2],
      cp: combatPower(snapshot.species[speciesId], iv, 20, snapshot),
      hp: hitPoints(snapshot.species[speciesId], iv[2], 20, snapshot),
    });
  const evaluated = evaluateCollection([
    make("best", "caterpie", [15, 13, 15]),
    make("second", "caterpie", [13, 13, 14]),
    make("other", "other", [10, 15, 15]),
  ], snapshot, { ...settings, raidSlots: 0 });
  const byId = new Map(evaluated.map((pokemon) => [pokemon.id, pokemon]));
  assert.equal(byId.get("best")?.analysis?.category, "collect");
  assert.match(byId.get("best")?.analysis?.reasons.join(" ") || "", /IV 43\/45.*高 IV 收藏代表/);
  assert.equal(byId.get("second")?.analysis?.category, "transfer");
  assert.ok(byId.get("second")?.analysis?.comparedWith.includes("best"));
  assert.equal(byId.get("other")?.analysis?.category, "collect");
});

test("同物種多隻傳說寶可夢都不列入可放生", () => {
  const snapshot = fixture();
  snapshot.version = "legendary-protection-fixture";
  snapshot.species.legend = species("legend", { tags: ["legendary"] });
  const records = [[11, 10, 12], [12, 11, 10]].map((iv, index) =>
    record(`legend-${index}`, {
      speciesId: "legend", favorite: false,
      ivAtk: iv[0], ivDef: iv[1], ivSta: iv[2],
      cp: combatPower(snapshot.species.legend, iv, 20, snapshot),
      hp: hitPoints(snapshot.species.legend, iv[2], 20, snapshot),
    }),
  );
  const evaluated = evaluateCollection(
    records, snapshot, { ...settings, raidSlots: 0, rareRepresentatives: 1 },
  );
  assert.ok(evaluated.every((pokemon) => pokemon.analysis?.category === "collect"));
  assert.ok(evaluated.every((pokemon) => transferExclusion(pokemon, snapshot) === "傳說、幻之或究極異獸"));
});

test("未登錄進化剪影與完整盒子缺少下一階才列為可進化", () => {
  const snapshot = fixture();
  snapshot.species.caterpie.evolutions = [
    { id: "metapod", candy: 12, condition: null },
  ];
  snapshot.species.metapod = species("metapod");
  const first = record("unevolved", {}, { evolutionSilhouette: true });
  const fullBox = new Set([first.id]);
  assert.equal(
    evaluateCollection([first], snapshot, settings, fullBox)[0].analysis?.category,
    "evolve",
  );
  assert.notEqual(
    evaluateCollection([first], snapshot, settings)[0].analysis?.category,
    "evolve",
  );
  const unknown = evaluateCollection(
    [{ ...first, evolutionSilhouette: null }], snapshot, settings, fullBox,
  )[0];
  assert.equal(unknown.analysis?.category, "review");
  assert.match(unknown.analysis?.reasons[0] || "", /進化剪影尚未判定/);
  const evolved = record("evolved", { speciesId: "metapod" });
  assert.notEqual(
    evaluateCollection(
      [first, evolved],
      snapshot,
      settings,
      new Set([first.id, evolved.id]),
    )[0].analysis?.category,
    "evolve",
  );
  snapshot.species.caterpie.evolutions.push({
    id: "butterfree",
    candy: 50,
    condition: null,
  });
  snapshot.species.butterfree = species("butterfree");
  assert.equal(
    evaluateCollection([first], snapshot, settings, fullBox)[0].analysis?.category,
    "evolve",
  );
  assert.equal(
    evaluateCollection([first, evolved], snapshot, settings, new Set([first.id, evolved.id]))[0].analysis?.category,
    "review",
  );
  const another = record("another-branch", {}, { evolutionSilhouette: true });
  const ranked = evaluateCollection(
    [first, another], snapshot, settings, new Set([first.id, another.id]),
  );
  assert.equal(ranked.filter((pokemon) => pokemon.analysis?.category === "evolve").length, 1);
});

test("粉色多分支進化按鈕的深色剪影可在模擬截圖辨識", async () => {
  const file = path.join(temp, "pink-evolutions.png");
  const svg = Buffer.from(`<svg width="600" height="855" xmlns="http://www.w3.org/2000/svg">
    <rect width="600" height="855" fill="white"/>
    <rect x="40" y="457" width="240" height="75" fill="#ffcae8"/>
    <rect x="118" y="483" width="24" height="24" fill="#41a978"/>
    <rect x="40" y="541" width="240" height="75" fill="#ffcae8"/>
    <rect x="118" y="568" width="24" height="24" fill="#bf93aa"/>
  </svg>`);
  await sharp(svg).png().toFile(file);
  assert.equal(await evolutionSilhouette(file, [
    { text: "進化", confidence: 1, x: 0.287, y: 0.404 },
    { text: "進化", confidence: 1, x: 0.287, y: 0.306 },
  ]), true);
});

test("道具進化按鈕的深粉色未登錄剪影可辨識", async () => {
  const file = path.join(temp, "rich-pink-evolution.png");
  const svg = Buffer.from(`<svg width="600" height="855" xmlns="http://www.w3.org/2000/svg">
    <rect width="600" height="855" fill="white"/>
    <rect x="40" y="457" width="240" height="75" fill="#df80b8"/>
    <rect x="105" y="483" width="42" height="30" fill="#a05b80"/>
  </svg>`);
  await sharp(svg).png().toFile(file);
  assert.equal(await evolutionSilhouette(file, [
    { text: "進化", confidence: 1, x: 0.287, y: 0.404 },
  ]), true);
});

test("灰藍色單一進化按鈕的未登錄剪影可辨識", async () => {
  const file = path.join(temp, "teal-evolution.png");
  const svg = Buffer.from(`<svg width="600" height="855" xmlns="http://www.w3.org/2000/svg">
    <rect width="600" height="855" fill="white"/>
    <rect x="40" y="457" width="240" height="75" fill="#c0e0e0"/>
    <rect x="108" y="483" width="36" height="30" fill="#80a0a0"/>
  </svg>`);
  await sharp(svg).png().toFile(file);
  assert.equal(await evolutionSilhouette(file, [
    { text: "進化", confidence: 1, x: 0.287, y: 0.404 },
  ]), true);
});

test("能力頁極巨化徽章與完整一般頁能區分；不完整畫面保持未知", () => {
  const line = (text: string, y: number, x = 0.35) =>
    ({ text, y, x, confidence: 0.9 });
  const detail = [line("CP290", 0.96), line("70/70 HP", 0.51),
    line("星星沙子", 0.22), line("強化", 0.13)];
  assert.equal(maxStatusFromOcr([...detail, line("極巨化", 0.32)]), "dynamax");
  assert.equal(maxStatusFromOcr([...detail, line("超極巨化", 0.32)]), "gigantamax");
  assert.equal(maxStatusFromOcr(detail), "none");
  assert.equal(maxStatusFromOcr([line("CP290", 0.96)]), null);
  assert.equal(maxStatusFromOcr([...detail, line("極巨化", 0.7)]), "none");
});

test("同物種極巨化只保留最佳一隻；超極巨化優先且未知不放生", () => {
  const snapshot = fixture();
  const ordinary = record("ordinary", { favorite: false }, { maxStatus: "none" });
  const dynamax = record("dynamax", { favorite: false }, { maxStatus: "dynamax" });
  const gigantamax = record("gigantamax", { favorite: false }, { maxStatus: "gigantamax" });
  const unknown = record("unknown", { favorite: false }, { maxStatus: null });
  const evaluated = evaluateCollection(
    [ordinary, dynamax, gigantamax, unknown], snapshot, settings,
  );
  const byId = new Map(evaluated.map((pokemon) => [pokemon.id, pokemon]));
  assert.equal(byId.get("gigantamax")?.analysis?.category, "collect");
  assert.equal(byId.get("dynamax")?.analysis?.category, "transfer");
  assert.equal(transferExclusion(byId.get("dynamax")!, snapshot), null);
  assert.ok(byId.get("dynamax")?.analysis?.comparedWith.includes("gigantamax"));
  assert.equal(byId.get("unknown")?.analysis?.category, "review");
  assert.ok(transferExclusion(byId.get("unknown")!, snapshot));
});

test("呱呱泡蛙進化線只保留一隻超級甲賀忍蛙代表，重複個體說明保留對象", () => {
  const snapshot = fixture();
  snapshot.species.froakie = species("froakie", {
    evolutions: [{ id: "frogadier", candy: 25, condition: null }],
  });
  snapshot.species.frogadier = species("frogadier", {
    evolutions: [{ id: "greninja", candy: 100, condition: null }],
  });
  snapshot.species.greninja = species("greninja");
  const froakie = record("froakie", {
    name: "呱呱泡蛙", speciesId: "froakie", favorite: false,
  }, { evolutionSilhouette: false });
  const greninjaIv = [15, 11, 14];
  const greninja = record("greninja", {
    name: "甲賀忍蛙", speciesId: "greninja", favorite: false,
    ivAtk: greninjaIv[0], ivDef: greninjaIv[1], ivSta: greninjaIv[2],
    cp: combatPower(snapshot.species.greninja, greninjaIv, 15, snapshot),
    hp: hitPoints(snapshot.species.greninja, greninjaIv[2], 15, snapshot),
  });
  const evaluated = evaluateCollection([froakie, greninja], snapshot, settings);
  assert.equal(evaluated[1].analysis?.category, "collect");
  assert.match(evaluated[1].analysis?.reasons.join(" ") || "", /超級甲賀忍蛙進化線/);
  assert.equal(evaluated[0].analysis?.category, "transfer");
  assert.match(evaluated[0].analysis?.reasons[0] || "", /已保留 甲賀忍蛙 CP/);
  assert.ok(evaluated[0].analysis?.comparedWith.includes("greninja"));
  assert.equal(transferExclusion(evaluated[0], snapshot), null);
  assert.equal(
    evaluateCollection([froakie], snapshot, settings)[0].analysis?.category,
    "collect",
  );
});

test("妙蛙花 14/15/15 是唯一已核對高 IV 時保留作超級進化代表", () => {
  const snapshot = fixture();
  snapshot.species.bulbasaur = species("bulbasaur", {
    evolutions: [{ id: "ivysaur", candy: 25, condition: null }],
  });
  snapshot.species.ivysaur = species("ivysaur", {
    evolutions: [{ id: "venusaur", candy: 100, condition: null }],
  });
  snapshot.species.venusaur = species("venusaur", { name: "妙蛙花" });
  const makeVenusaur = (id: string, iv: number[], verified = true) =>
    record(id, {
      name: "妙蛙花", speciesId: "venusaur", favorite: false,
      ivAtk: iv[0], ivDef: iv[1], ivSta: iv[2],
      cp: combatPower(snapshot.species.venusaur, iv, 25, snapshot),
      hp: hitPoints(snapshot.species.venusaur, iv[2], 25, snapshot),
    }, { verified });
  const best = makeVenusaur("best", [14, 15, 15]);
  const lower = makeVenusaur("lower", [10, 10, 10]);
  const pending = makeVenusaur("pending", [15, 11, 15], false);
  const evaluated = evaluateCollection(
    [best, lower, pending], snapshot, { ...settings, raidSlots: 0, metaCutoff: 0 },
  );
  const byId = new Map(evaluated.map((pokemon) => [pokemon.id, pokemon]));
  assert.equal(byId.get("best")?.analysis?.category, "collect");
  assert.match(byId.get("best")?.analysis?.reasons.join(" ") || "", /超級妙蛙花進化線/);
  assert.equal(byId.get("lower")?.analysis?.category, "transfer");
  assert.ok(byId.get("lower")?.analysis?.comparedWith.includes("best"));
  assert.equal(byId.get("pending")?.analysis?.category, "review");
});

test("同一未登錄進化型只保留最佳個體，該個體不進入放生名單", () => {
  const snapshot = fixture();
  snapshot.species.caterpie.evolutions = [
    { id: "metapod", candy: 12, condition: null },
  ];
  snapshot.species.metapod = species("metapod");
  const weakerIv = [10, 10, 10];
  const weaker = record("weaker", {
    favorite: false,
    ivAtk: weakerIv[0],
    ivDef: weakerIv[1],
    ivSta: weakerIv[2],
    cp: combatPower(snapshot.species.caterpie, weakerIv, 15, snapshot),
    hp: hitPoints(snapshot.species.caterpie, weakerIv[2], 15, snapshot),
  }, { evolutionSilhouette: true });
  const stronger = record("stronger", { favorite: false }, {
    evolutionSilhouette: true,
  });
  const evaluated = evaluateCollection(
    [weaker, stronger], snapshot, settings,
    new Set([weaker.id, stronger.id]),
  );
  assert.equal(evaluated.find((p) => p.id === stronger.id)?.analysis?.category, "evolve");
  assert.equal(evaluated.find((p) => p.id === weaker.id)?.analysis?.category, "transfer");
  assert.ok(transferExclusion(evaluated[1], snapshot));
  assert.equal(transferExclusion(evaluated[0], snapshot), null);
});

test("錄影中的綠毛蟲：CP 179、HP 72、IV 14/12/13 對應等級 15", () => {
  const s = fixture(),
    p = record("one");
  assert.equal(combatPower(s.species.caterpie, [14, 12, 13], 15, s), 179);
  assert.equal(hitPoints(s.species.caterpie, 13, 15, s), 72);
  assert.deepEqual(inferLevels(s.species.caterpie, p.fields, s), [15]);
});
test("CP／HP 不一致時不能推測唯一等級", () => {
  const s = fixture();
  assert.deepEqual(
    inferLevels(s.species.caterpie, record("x", { hp: 999 }).fields, s),
    [],
  );
});
test("等級 40 跨至 41 使用 XL，不再計普通糖", () => {
  const s = fixture();
  assert.deepEqual(powerCost(39.5, 41, record("x").fields, s), {
    dust: 3000,
    candy: 2,
    xl: 20,
    approximate: true,
  });
  assert.equal(
    powerCost(40, 40.5, record("x", { shadow: true }).fields, s).xl,
    12,
  );
});
test("淨化與暗影成本各自套用倍率並逐次進位", () => {
  const s = fixture();
  assert.equal(
    powerCost(10, 11, record("x", { purified: true }).fields, s).dust,
    1800,
  );
  assert.equal(
    powerCost(10, 11, record("x", { shadow: true }).fields, s).candy,
    6,
  );
});
test("IV 排名遍歷 4096 組：CP 遠低於上限的滿 IV 排名第一", () => {
  const s = fixture();
  assert.equal(rankIV(s.species.caterpie, [15, 15, 15], 1500, s).rank, 1);
  const low = rankIV(s.species.caterpie, [0, 0, 0], 1500, s);
  assert.ok(low.rank > 4000);
  assert.ok(low.cp <= 1500);
});
test("進化分支遵守性別限制，服裝不能推斷可進化", () => {
  const s = fixture();
  s.species.caterpie.evolutions = [
    { id: "female", candy: 50, condition: "僅雌性", gender: "female" },
  ];
  s.species.female = species("female");
  assert.equal(
    evolutionPaths(s.species.caterpie, record("x").fields, s).length,
    1,
  );
  assert.equal(
    evolutionPaths(
      s.species.caterpie,
      record("x", { gender: "female" }).fields,
      s,
    ).length,
    2,
  );
  assert.equal(
    evolutionPaths(
      s.species.caterpie,
      record("x", { gender: "female", costume: "hat" }).fields,
      s,
    ).length,
    1,
  );
});
test("過了聯盟 CP 的個體不能建議降級進入聯盟", () => {
  const s = fixture();
  s.species.caterpie = { ...s.species.caterpie, atk: 200, def: 180, sta: 190 };
  const iv = [14, 12, 13],
    f = {
      cp: combatPower(s.species.caterpie, iv, 40, s),
      hp: hitPoints(s.species.caterpie, 13, 40, s),
    };
  const [p] = evaluateCollection([record("x", f)], s, settings);
  assert.equal(
    p.analysis!.leagues.find((l) => l.league === 1500)?.eligible,
    false,
  );
});
test("尚未核對、缺 IV、缺暗影狀態或缺資料不能放生", () => {
  const s = fixture();
  for (const p of [
    record("a", {}, { verified: false }),
    record("b", { ivAtk: null }),
    record("c", { shadow: null }),
    record("d", { speciesId: "not-present" }),
  ])
    assert.equal(
      evaluateCollection([p], s, settings)[0].analysis?.category,
      "review",
    );
  assert.equal(
    evaluateCollection([record("x")], null, settings)[0].analysis?.category,
    "review",
  );
});
test("普通且用途低的已核對個體可放生；手動鎖定優先", () => {
  const s = fixture();
  assert.equal(
    evaluateCollection([record("a")], s, settings)[0].analysis?.category,
    "transfer",
  );
  assert.equal(
    evaluateCollection([record("b", {}, { locked: true })], s, settings)[0]
      .analysis?.category,
    "collect",
  );
});
test("確認色違全部保留，已放生個體不佔名額", () => {
  const s = fixture(),
    a = record("a", { shiny: true }),
    b = record("b", { shiny: true });
  const rows = evaluateCollection([a, b], s, settings);
  assert.equal(
    rows.filter((p) => p.analysis?.category === "collect").length,
    2,
  );
  assert.equal(
    rows.filter((p) => p.analysis?.category === "transfer").length,
    0,
  );
  const archived = evaluateCollection([{ ...a, owned: false }, b], s, settings);
  assert.equal(archived[1].analysis?.category, "collect");
});
test("環境排名好仍須具備個體條件，不只看 IV 總和", () => {
  const s = fixture();
  s.rankings["1500"] = [{ speciesId: "caterpie", score: 100, moves: [] }];
  const p = record("x", {
    ivAtk: 15,
    ivDef: 15,
    ivSta: 15,
    cp: combatPower(s.species.caterpie, [15, 15, 15], 15, s),
    hp: hitPoints(s.species.caterpie, 15, 15, s),
  });
  assert.equal(
    evaluateCollection([p], s, settings)[0].analysis?.category,
    "invest",
  );
});
test("未核對的高IV候選不會擠掉已核對個體的PvP名額", () => {
  const s = fixture();
  s.rankings["1500"] = [{ speciesId: "caterpie", score: 100, moves: [] }];
  const a = record("confirmed"),
    b = record(
      "unverified",
      {
        ivAtk: 15,
        ivDef: 15,
        ivSta: 15,
        cp: combatPower(s.species.caterpie, [15, 15, 15], 15, s),
        hp: hitPoints(s.species.caterpie, 15, 15, s),
      },
      { verified: false },
    );
  const rows = evaluateCollection([a, b], s, settings);
  assert.equal(rows[0].analysis?.category, "invest");
  assert.equal(rows[1].analysis?.category, "review");
});
test("暗影淨化 IV 每項 +2 且不超過15；不因滿IV直接推薦淨化", () => {
  const s = fixture();
  s.species.caterpie_shadow = species("caterpie_shadow", { tags: ["shadow"] });
  const iv = [13, 14, 15],
    p = record("x", {
      speciesId: "caterpie_shadow",
      shadow: true,
      ivAtk: 13,
      ivDef: 14,
      ivSta: 15,
      cp: combatPower(s.species.caterpie, iv, 15, s),
      hp: hitPoints(s.species.caterpie, 15, 15, s),
    });
  const a = evaluateCollection([p], s, settings)[0].analysis!;
  assert.deepEqual(a.purification?.iv, [15, 15, 15]);
  assert.match(a.purification!.verdict, /先保留暗影/);
});
test("簡化 DPS 納入暗影加成，但缺招式資料不產生假數字", () => {
  const s = fixture();
  const base = cycleDps(s.species.caterpie, 15, 35, "BUG_BITE", "STRUGGLE", s);
  assert.ok(base > 0);
  assert.ok(
    cycleDps(
      { ...s.species.caterpie, tags: ["shadow"] },
      15,
      35,
      "BUG_BITE",
      "STRUGGLE",
      s,
    ) > base,
  );
  assert.equal(
    cycleDps(s.species.caterpie, 15, 35, "UNKNOWN", "STRUGGLE", s),
    0,
  );
});
test("相同物種與 CP 仍不足以自動配對", () => {
  const a = record("a").fields;
  assert.equal(matching(a, { ...a, weight: null, height: null }), "possible");
  assert.equal(matching(a, { ...a, weight: 3 }), "different");
  assert.equal(matching(a, { ...a }), "exact");
});
const observation = (
  key: string,
  fields = record("x").fields,
): Observation => ({
  id: key,
  jobId: "job",
  segment: key,
  frame: `job/${key}.jpg`,
  time: 1,
  video: "other.mp4",
  fields,
  issues: [],
  ivMeasured: null,
  kind: "details",
});
test("跨錄影唯一完整指紋才合併，人工修正不被覆蓋", () => {
  const p = record("a", {}, { overrides: { name: "我改的名字" } }),
    rows = integrateObservations([observation("one")], [p]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].overrides.name, "我改的名字");
  assert.equal(rows[0].sources.length, 1);
});
test("多個候選不能自動合併；未知資料也不亂合併", () => {
  const rows = integrateObservations(
    [observation("one")],
    [record("a"), record("b")],
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[2].candidates.length, 2);
  assert.equal(rows[0].verified, false);
});
test("同一切段讀到不同物種時拆成兩個個體", () => {
  const a = observation("a"),
    b = {
      ...observation("b", { ...record("x").fields, speciesId: "dewpider" }),
      segment: "a",
    };
  assert.equal(integrateObservations([a, b], []).length, 2);
});
test("AI 與評價條數字不一致時必須要求核對", () => {
  const result = reconcileIV(
    { ...emptyFields(), ivAtk: 15, ivDef: 10, ivSta: 8 },
    [14, 10, 8],
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.fields.ivAtk, 15);
});
test("量測所有 IV 刻度邊界：0、1、5、10、14、15", async () => {
  for (const value of [0, 1, 5, 10, 14, 15]) {
    const bars = [920, 980, 1040]
      .map(
        (y) =>
          `<rect x="72" y="${y}" width="207" height="8" rx="4" fill="#dddde0"/>${value ? `<rect x="72" y="${y}" width="${(207 * value) / 15}" height="8" rx="4" fill="#f1a348"/>` : ""}`,
      )
      .join("");
    const image = await sharp(
      Buffer.from(
        `<svg width="600" height="1304"><rect width="600" height="1304" fill="white"/>${bars}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    assert.deepEqual(
      (await measureIV(image))?.values,
      [value, value, value],
      `value ${value}`,
    );
    const savedEvidence = await sharp(image)
      .extract({ left: 0, top: 72, width: 600, height: 1000 })
      .jpeg({ quality: 90 })
      .toBuffer();
    assert.deepEqual(
      (await measureIV(savedEvidence))?.values,
      [value, value, value],
      `saved evidence value ${value}`,
    );
  }
});
test("沒有 API key 時不假裝已辨識", async () => {
  fs.mkdirSync(path.join(temp, "frames", "test"), { recursive: true });
  fs.writeFileSync(
    path.join(temp, "frames", "test", "one.jpg"),
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer(),
  );
  store.remove("settings", "runtime-config");
  await assert.rejects(
    () =>
      recognize("test/one.jpg", null, new AbortController().signal, () => {}),
    /API key/,
  );
});
test("Responses API 結構化辨識會重試429、記錄用量並快取相同畫面", async () => {
  const original = globalThis.fetch;
  store.put("settings", "runtime-config", {
    apiKey: "test-not-a-real-key",
    baseUrl: "http://127.0.0.1:1234/v1",
  });
  let calls = 0;
  const urls: string[] = [];
  const parsed = {
    kind: "appraisal",
    fields: record("response").fields,
    issues: [],
    clear: true,
  };
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    calls++;
    if (calls === 1)
      return new Response(
        JSON.stringify({
          error: { message: "rate limited", type: "rate_limit_error" },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    return new Response(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "gpt-4.1-mini",
        output: [
          {
            id: "msg_test",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(parsed),
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 123, output_tokens: 45, total_tokens: 168 },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const usage: unknown[] = [];
    const first = await recognize(
      "test/one.jpg",
      fixture(),
      new AbortController().signal,
      (u) => usage.push(u),
    );
    assert.equal(first.fields.cp, 179);
    assert.equal(calls, 2);
    assert.deepEqual(usage, [{ input: 123, output: 45, cached: false }]);
    await recognize(
      "test/one.jpg",
      fixture(),
      new AbortController().signal,
      (u) => usage.push(u),
    );
    assert.equal(calls, 2);
    assert.ok(urls.every((url) => url === "http://127.0.0.1:1234/v1/responses"));
    assert.deepEqual(usage[1], { input: 0, output: 0, cached: true });
    store.put("settings", "runtime-config", {
      apiKey: "test-not-a-real-key",
      baseUrl: "http://127.0.0.1:5678/v1",
    });
    await recognize(
      "test/one.jpg",
      fixture(),
      new AbortController().signal,
      (u) => usage.push(u),
    );
    assert.equal(calls, 3, "切換伺服器後必須重新辨識，不能共用舊快取");
    assert.equal(urls[2], "http://127.0.0.1:5678/v1/responses");
  } finally {
    globalThis.fetch = original;
    store.remove("settings", "runtime-config");
  }
});
test("AI 等候重試時可以取消，不繼續產生請求", async () => {
  const original = globalThis.fetch;
  store.put("settings", "runtime-config", { apiKey: "test-not-a-real-key" });
  const control = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    setTimeout(() => control.abort(), 20);
    return new Response(
      JSON.stringify({ error: { message: "rate limited" } }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await assert.rejects(
      () => recognize("test/one.jpg", null, control.signal, () => {}),
      /取消/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    store.remove("settings", "runtime-config");
  }
});
test("完整備份可還原且重複匯入不覆蓋人工修正", async () => {
  store.saveSnapshot(fixture());
  const p = record("backup", {}, { maxStatus: "dynamax" });
  store.put("pokemon", p.id, p);
  const backup = await exportBackup();
  store.remove("pokemon", p.id);
  assert.equal((await importBackup(backup)).imported, 1);
  assert.equal(store.get<PokemonType>("pokemon", p.id)?.maxStatus, "dynamax");
  store.put("pokemon", p.id, {
    ...store.get("pokemon", p.id)!,
    overrides: { name: "已修改" },
  });
  assert.equal((await importBackup(backup)).skipped, 1);
  assert.equal(
    store.get<PokemonType>("pokemon", p.id)?.overrides.name,
    "已修改",
  );
});
type PokemonType = ReturnType<typeof record>;
test("備份路徑無法逃離來源目錄；CSV 防止公式注入", async () => {
  assert.equal(validFrame("job/../../etc.jpg"), false);
  assert.equal(validFrame("job/one.jpg"), true);
  const csv = exportCsv([record("csv", { name: "=1+1" })]);
  assert.ok(csv.includes("'=1+1"));
  await assert.rejects(() =>
    importBackup({
      format: "pogo-local-backup",
      version: 1,
      pokemon: [],
      observations: [],
      settings,
      snapshot: null,
      frames: { "../secret": "abc" },
    }),
  );
});
test("SQLite 交易失敗時回復原資料", () => {
  assert.throws(() =>
    store.transaction(() => {
      store.put("settings", "rollback", { value: true });
      throw new Error("rollback");
    }),
  );
  assert.equal(store.get("settings", "rollback"), null);
});

test("遊戲資料更新失敗時保留已驗證的舊快照", async () => {
  const { updateGameData } = await import("../src/lib/game-data");
  const original = globalThis.fetch;
  const version = store.getSnapshot()!.version;
  globalThis.fetch = async () =>
    new Response("temporarily unavailable", { status: 503 });
  try {
    await assert.rejects(() => updateGameData(), /無法更新/);
    assert.equal(store.getSnapshot()!.version, version);
  } finally {
    globalThis.fetch = original;
  }
});
