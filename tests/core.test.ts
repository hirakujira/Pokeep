import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fixture, record, species, settings } from "./fixtures";
import { effective, emptyFields, settingsSchema, validFrame, type Fields, type Observation, type Pokemon } from "../src/lib/types";
import { canonicalCostume, costumeVocabulary, knownCostumes } from "../src/lib/costumes";
import type { ScanItem } from "../src/lib/iphone-types";

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
  verificationEvidenceGaps,
  reconcileReviewedEvidence,
  cycleDps,
} = await import("../src/lib/evaluate");
const { matching } = await import("../src/lib/matching");
const { measureIV } = await import("../src/lib/iv");
const { evolutionSilhouette } = await import("../src/lib/evolution-silhouette");
const { maxStatusFromOcr, maxStatusFromEvidence } = await import("../src/lib/max-status");
const { moveName, localizeMoveText } = await import("../src/lib/move-names");
const { localizeSpeciesName } = await import("../src/lib/species-names");
const { typeName } = await import("../src/lib/type-names");
const { transferExclusion, requireSpecialCorroboration } = await import("../src/lib/iphone-safety");
const store = await import("../src/lib/store");
const { exportBackup, importBackup, exportCsv } = await import("../src/lib/backup");
after(() => {
  store.db().close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("物種與地區形態顯示繁中，保留原始 ID 作配對", () => {
  assert.equal(localizeSpeciesName("小拉達 (Alolan)", "rattata_alolan"),
    "小拉達（阿羅拉的樣子）");
  assert.equal(localizeSpeciesName("烏波 (Paldean)", "wooper_paldean"),
    "烏波（帕底亞的樣子）");
  assert.equal(localizeSpeciesName("肯泰羅 (Aqua)", "tauros_aqua"),
    "肯泰羅（帕底亞・水瀾種）");
  assert.equal(localizeSpeciesName("雷電雲 (Therian)（暗影）", "thundurus_therian_shadow"),
    "雷電雲（靈獸形態）（暗影）");
  assert.equal(localizeSpeciesName("酋雷姆 (Black)", "kyurem_black"), "闇黑酋雷姆");
  assert.equal(localizeSpeciesName("寶可夢 (Unknown)"), "寶可夢 (Unknown)");
});

test("自動核對失敗列出保存的畫面缺口", () => {
  const item: ScanItem = {
    id: "item", scanId: "scan", position: 0,
    frame: "scan/top.jpg", appraisalFrame: "scan/iv.jpg", movesFrame: "scan/moves.jpg",
    fingerprint: "fingerprint", pokemonId: "pokemon", fields: null,
    issues: [], protectionClear: false, measuredIV: [10, 12, 14],
    capturedAt: "2026-10-26T00:00:00.000Z",
  };
  const top: Observation = {
    id: "top", jobId: "scan", frame: item.frame, issues: [], ivMeasured: null,
    capturedAt: item.capturedAt, scanItemId: item.id,
    fields: { ...emptyFields(), name: "喵喵", cp: 14 },
  };
  const appraisal: Observation = {
    ...top, id: "iv", frame: item.appraisalFrame!,
    ivMeasured: [10, 12, 14],
    fields: { ...emptyFields(), cp: 14, ivAtk: 10, ivDef: 12, ivSta: 14 },
  };
  assert.deepEqual(verificationEvidenceGaps(item, top, appraisal, [5]), [
    "外觀辨識未能確認沒有特殊服裝",
    "評價頁名稱辨識結果為空，無法交叉比對",
  ]);
  assert.deepEqual(verificationEvidenceGaps({ ...item, protectionClear: true },
    top, { ...appraisal, fields: { ...appraisal.fields, name: "喵喵" } }, [5]), []);
  assert.deepEqual(verificationEvidenceGaps(null, top, appraisal, [5]),
    ["沒有保存可供自動核對的手機掃描檢查點"]);
  assert.deepEqual(verificationEvidenceGaps(item, top, appraisal, [5], [], "胸前護目鏡"), [
    "已辨識特殊服裝（胸前護目鏡），造型需人工核對",
    "評價頁名稱辨識結果為空，無法交叉比對",
  ]);
});

test("人工核對後只清理已解決的物種缺口，並補回無性別資料", () => {
  const snapshot = fixture();
  snapshot.species.ditto = species("ditto", { genderless: true });
  const reviewed = record("ditto", { speciesId: "ditto", gender: null }, {
    verification: "human",
    issues: ["物種／形態無法唯一對應，請人工核對", "能力與評價頁名稱不一致"],
  });
  const reconciled = reconcileReviewedEvidence(reviewed, snapshot);
  assert.equal(reconciled.fields.gender, "genderless");
  assert.deepEqual(reconciled.issues, ["能力與評價頁名稱不一致"]);
  assert.deepEqual(reviewed.issues, ["物種／形態無法唯一對應，請人工核對", "能力與評價頁名稱不一致"]);
  assert.equal(reconcileReviewedEvidence({ ...reviewed, verified: false }, snapshot).fields.gender, null);
  assert.equal(reconcileReviewedEvidence({ ...reviewed, overrides: { gender: null } }, snapshot).fields.gender, null);
});

test("服裝名稱沿用收藏中已用過的名稱，人工修正前的原文成為別名", () => {
  const corrected = record("corrected", { speciesId: "charmander", costume: "泳鏡" },
    { overrides: { costume: "胸前護目鏡" } });
  const known = knownCostumes([
    corrected,
    record("plain", { speciesId: "charmander", costume: "胸前護目鏡" }),
    record("shadow", { speciesId: "charmander_shadow", costume: "派對帽" }),
    record("stale", { speciesId: "charmander", costume: "泳鏡" }),
    record("piplup", { speciesId: "piplup", costume: "南瓜帽" }),
  ]).get("charmander");
  assert.deepEqual(known?.names, ["胸前護目鏡", "派對帽"]);
  assert.equal(canonicalCostume(known, "泳 鏡"), "胸前護目鏡");
  assert.equal(canonicalCostume(known, "派對帽"), "派對帽");
  assert.equal(canonicalCostume(known, "南瓜帽"), "南瓜帽");
  assert.equal(canonicalCostume(undefined, "泳鏡"), "泳鏡");
  const snapshot = fixture();
  snapshot.species.charmander = species("charmander", { name: "小火龍" });
  assert.deepEqual(costumeVocabulary(new Map([["charmander", known!], ["missing", known!]]), snapshot),
    ["小火龍：胸前護目鏡、派對帽"]);
  const evaluated = evaluateCollection([
    corrected,
    record("second", { speciesId: "charmander", form: "一般", costume: "胸前護目鏡" }),
  ], snapshot, { ...settings, rareRepresentatives: 1 });
  assert.equal(evaluated.filter((p) => p.analysis?.reasons.includes("服裝「胸前護目鏡」收藏代表（同組前 1 名）")).length, 1);
  assert.deepEqual(evaluated.map((p) => p.analysis?.category), ["collect", "collect"]);
});

test("服裝皮卡丘的獨立 ID 算服裝收藏，不算形態", () => {
  const snapshot = fixture();
  snapshot.species.pikachu_pop_star = species("pikachu_pop_star", { form: "(Pop Star)" });
  const [popStar] = evaluateCollection([record("pop", { speciesId: "pikachu_pop_star" })], snapshot, settings);
  assert.equal(effective(popStar).costume, "流行偶像");
  assert.deepEqual(popStar.analysis?.collectionKeys.map((key) => key.label), ["服裝「流行偶像」"]);
  assert.equal(effective(record("named", { speciesId: "pikachu_pop_star", costume: "舞台裝" })).costume, "舞台裝");
  assert.equal(effective(record("plain", { speciesId: "pikachu" })).costume, null);
});

test("單張畫面的暗影與淨化判斷須有招式或第二畫面佐證", () => {
  const snapshot = fixture();
  snapshot.species.pikachu = species("pikachu", { dex: 25 });
  snapshot.species.pikachu_shadow = species("pikachu_shadow", { dex: 25, tags: ["shadow"] });
  const appearanceOnly = { ...emptyFields(), speciesId: "pikachu_shadow", shadow: true, purified: false };
  assert.equal(requireSpecialCorroboration(appearanceOnly, snapshot), true);
  assert.equal(appearanceOnly.speciesId, "pikachu");
  assert.equal(appearanceOnly.shadow, null);
  assert.equal(appearanceOnly.purified, null);
  const moveProof = { ...emptyFields(), speciesId: "pikachu_shadow", shadow: true, purified: false, chargeMove: "FRUSTRATION" };
  assert.equal(requireSpecialCorroboration(moveProof, snapshot), false);
  assert.equal(moveProof.shadow, true);
  const purifiedAppearance = { ...emptyFields(), speciesId: "pikachu", shadow: false, purified: true };
  assert.equal(requireSpecialCorroboration(purifiedAppearance, snapshot), true);
  assert.equal(purifiedAppearance.purified, null);
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
  assert.equal(moveName("HIDDEN_POWER_BUG", names), "覺醒力量（蟲）");
  assert.equal(moveName("預知未來", names), "預知未來");
  assert.equal(
    localizeMoveText("招式 AEGISLASH_CHARGE_PSYCHO_CUT、Chilling Water", names),
    "招式 精神利刃、冷水",
  );
});

test("招式池缺 PvE 數值不誤報到個體；只提示目前辨識的缺值招式", () => {
  const snapshot = fixture();
  snapshot.species.caterpie = species("caterpie", {
    name: "圖圖犬",
    fast: ["BUG_BITE", "HIDDEN_POWER_BUG"],
    charged: ["STRUGGLE", "FUTURE_SIGHT"],
  });
  const known = record("known-moves", {
    name: "圖圖犬", fastMove: "BUG_BITE", chargeMove: "STRUGGLE",
  });
  const [assessed] = evaluateCollection([known], snapshot, settings);
  assert.ok(!assessed.analysis?.warnings.some((warning) => warning.includes("PvE")));
  const localized = record("localized-move", {
    name: "圖圖犬", fastMove: "蟲咬", chargeMove: "掙扎",
  });
  const [withLocalizedMoves] = evaluateCollection([localized], snapshot, settings);
  assert.ok(!withLocalizedMoves.analysis?.warnings.some((warning) => warning.includes("PvE")));
  snapshot.moves.OUTRAGE = {
    id: "OUTRAGE", name: "逆麟", type: "dragon", power: 110,
    energy: -50, duration: 4,
  };
  const alternateSpelling = record("alternate-spelling", {
    name: "圖圖犬", fastMove: "BUG_BITE", chargeMove: "逆鱗",
  });
  const [withAlternateSpelling] = evaluateCollection([alternateSpelling], snapshot, settings);
  assert.ok(!withAlternateSpelling.analysis?.warnings.some((warning) => warning.includes("PvE")));
  const unknown = record("unknown-move", {
    name: "圖圖犬", fastMove: "HIDDEN_POWER_BUG", chargeMove: "STRUGGLE",
  });
  const [withMissingEquippedMove] = evaluateCollection([unknown], snapshot, settings);
  assert.ok(withMissingEquippedMove.analysis?.warnings.some((warning) =>
    warning.includes("覺醒力量（蟲）") && warning.includes("目前辨識的招式")));
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

test("保留理由依優先度排序，列表第一條顯示最重要的理由", () => {
  const snapshot = fixture();
  snapshot.version = "keep-reason-order-fixture";
  snapshot.rankings["10000"] = [{ speciesId: "caterpie", score: 100, moves: [] }];
  snapshot.moves.STRUGGLE.type = "bug";
  snapshot.species.caterpie.tags = ["mythical"];
  const [invest] = evaluateCollection(
    [record("rare-combat", {}, { evolutionSilhouette: "unavailable" })], snapshot, settings,
  );
  assert.equal(invest.analysis?.category, "invest");
  assert.match(invest.analysis?.reasons[0] || "", /入選 PvP/);
  assert.match(invest.analysis?.reasons[1] || "", /入選團體戰/);
  assert.equal(invest.analysis?.reasons[2], "幻之寶可夢，保留且不列入放生候選");
  assert.equal(invest.analysis?.reasons.at(-1), "已人工確認此個體沒有進化按鈕");
  const [locked] = evaluateCollection(
    [record("rare-locked", {}, { locked: true })], snapshot, settings,
  );
  assert.equal(locked.analysis?.reasons[0], "已由你鎖定保留");

  snapshot.species.castform_rainy = species("castform_rainy", { form: "(Rainy)" });
  const target = snapshot.species.castform_rainy;
  const [best, second] = evaluateCollection(
    ([["雨天", [14, 14, 14]], ["rainy", [13, 14, 15]]] as const)
      .map(([form, iv], index) => record(`castform-${index}`, {
        speciesId: "castform_rainy", form,
        ivAtk: iv[0], ivDef: iv[1], ivSta: iv[2],
        cp: combatPower(target, [...iv], 20, snapshot),
        hp: hitPoints(target, iv[2], 20, snapshot),
      }, { evolutionSilhouette: "unavailable" })),
    snapshot, { ...settings, raidSlots: 0, rareRepresentatives: 2 },
  );
  assert.deepEqual(best.analysis?.reasons, [
    "形態「雨水的樣子」收藏代表（同組前 2 名）",
    "IV 42/45；保留此物種已核對個體中最佳的高 IV 收藏代表",
    "已人工確認此個體沒有進化按鈕",
  ]);
  assert.equal(second.analysis?.category, "collect");
  assert.equal(second.analysis?.reasons[0], "形態「雨水的樣子」收藏代表（同組前 2 名）");
});

test("地區形態不算特殊收藏，只靠高 IV、色違等其他理由保留", () => {
  const snapshot = fixture();
  snapshot.species.geodude_alolan = species("geodude_alolan", { form: "(Alolan)" });
  const target = snapshot.species.geodude_alolan;
  const evaluated = evaluateCollection(
    ([
      ["alolan", [15, 14, 13], false],
      ["阿羅拉", [12, 12, 15], false],
      ["阿羅拉", [10, 13, 14], false],
      ["阿羅拉", [6, 2, 6], true],
    ] as const).map(([form, iv, shiny], index) => record(`geodude-${index}`, {
      speciesId: "geodude_alolan", form, shiny,
      ivAtk: iv[0], ivDef: iv[1], ivSta: iv[2],
      cp: combatPower(target, [...iv], 20, snapshot),
      hp: hitPoints(target, iv[2], 20, snapshot),
    })),
    snapshot, { ...settings, raidSlots: 0, rareRepresentatives: 2 },
  );
  assert.deepEqual(evaluated.map((p) => p.analysis?.category), ["collect", "transfer", "transfer", "collect"]);
  assert.match(evaluated[0].analysis?.reasons[0] || "", /IV 42\/45.*高 IV 收藏代表/);
  assert.ok(evaluated.every((p) => !p.analysis?.reasons.some((r) => r.startsWith("形態「"))));
  assert.ok(evaluated[3].analysis?.reasons.includes("色違收藏代表（同組前 2 名）"));
});

test("招式學習器依招式池分出一般／厲害、成功率、遷怒限制與先進化", () => {
  const snapshot = fixture();
  snapshot.version = "move-training-fixture";
  Object.assign(snapshot.moves, {
    FURY_CUTTER: { id: "FURY_CUTTER", name: "連斬", type: "bug", power: 1, energy: 6, duration: 0.5 },
    TACKLE: { id: "TACKLE", name: "撞擊", type: "normal", power: 5, energy: 5, duration: 0.5 },
    X_SCISSOR: { id: "X_SCISSOR", name: "十字剪", type: "bug", power: 45, energy: -35, duration: 1.6 },
    BUG_BUZZ: { id: "BUG_BUZZ", name: "蟲鳴", type: "bug", power: 150, energy: -50, duration: 3.7 },
    SWIFT: { id: "SWIFT", name: "高速星星", type: "normal", power: 65, energy: -50, duration: 2.8 },
  });
  const moves = {
    fast: ["BUG_BITE", "FURY_CUTTER", "TACKLE", "HIDDEN_POWER_BUG", "HIDDEN_POWER_FIRE"],
    charged: ["STRUGGLE", "X_SCISSOR", "BUG_BUZZ", "SWIFT"],
    elite: ["BUG_BUZZ"],
  };
  snapshot.species.caterpie = species("caterpie", moves);
  snapshot.species.caterpie_shadow = species("caterpie_shadow", { ...moves, tags: ["shadow"] });
  snapshot.species.egg = species("egg", {
    fast: ["NO_PVE"],
    charged: [],
    evolutions: [{ id: "caterpie", candy: 12, condition: null }],
  });
  snapshot.rankings["10000"] = [
    { speciesId: "caterpie", score: 100, moves: ["BUG_BITE", "X_SCISSOR", "STRUGGLE"] },
    { speciesId: "caterpie_shadow", score: 90, moves: ["BUG_BITE", "X_SCISSOR", "STRUGGLE"] },
  ];
  const [regular, shadow, egg, ready] = evaluateCollection([
    record("regular", { fastMove: "連斬", chargeMove: "STRUGGLE" }),
    record("shadow", {
      speciesId: "caterpie_shadow", shadow: true, fastMove: "BUG_BITE", chargeMove: "FRUSTRATION",
    }),
    record("egg", { speciesId: "egg" }),
    record("ready", { fastMove: "BUG_BITE", chargeMove: "BUG_BUZZ" }),
  ], snapshot, settings);
  const bugRaid = (p: typeof regular) =>
    p.analysis!.moveTraining!.find((a) => a.purpose === "raid" && a.label.includes("蟲屬性"))!;
  const pvp = (p: typeof regular) =>
    p.analysis!.moveTraining!.find((a) => a.purpose === "pvp")!;
  const steps = (a: ReturnType<typeof pvp>) =>
    a.steps.map(({ tm, from, to, odds, blocked }) => ({ tm, from, to, odds, blocked }));

  assert.equal(bugRaid(regular).status, "train");
  // Both Hidden Power types count as one roll: BUG_BITE, TACKLE or Hidden Power.
  assert.deepEqual(steps(bugRaid(regular)), [
    { tm: "fast", from: "FURY_CUTTER", to: "BUG_BITE", odds: 3, blocked: false },
    { tm: "eliteCharged", from: "STRUGGLE", to: "BUG_BUZZ", odds: 1, blocked: false },
  ]);
  assert.ok(bugRaid(regular).dps!.best > bugRaid(regular).dps!.current);
  assert.equal(pvp(regular).label, "大師聯盟 環境 #1");
  assert.deepEqual(steps(pvp(regular)), [
    { tm: "fast", from: "FURY_CUTTER", to: "BUG_BITE", odds: 3, blocked: false },
    { tm: "charged", from: null, to: "X_SCISSOR", odds: 2, blocked: false },
  ]);
  assert.match(pvp(regular).steps[1].note!, /先解鎖第二特殊招式/);
  assert.ok(regular.analysis!.actions.some((a) => a.includes("「招式學習器」")));

  assert.deepEqual(steps(bugRaid(shadow)), [
    { tm: "eliteCharged", from: null, to: "BUG_BUZZ", odds: 1, blocked: false },
  ]);
  assert.deepEqual(steps(pvp(shadow)), [
    { tm: "charged", from: null, to: "X_SCISSOR", odds: 3, blocked: false },
    { tm: "charged", from: "FRUSTRATION", to: "STRUGGLE", odds: 2, blocked: true },
  ]);
  assert.match(pvp(shadow).steps[1].note!, /遷怒/);

  assert.ok(egg.analysis!.moveTraining!.length > 0);
  assert.ok(egg.analysis!.moveTraining!.every((a) =>
    a.status === "evolveFirst" && a.speciesId === "caterpie" && !a.steps.length,
  ));
  assert.equal(bugRaid(ready).status, "ready");
  assert.deepEqual(bugRaid(ready).steps, []);
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
  assert.ok(evaluated.every((pokemon) =>
    pokemon.analysis?.reasons[0] === "傳說寶可夢，保留且不列入放生候選" &&
    !pokemon.analysis.reasons.some((reason) => reason.includes("（同組前")),
  ));
});

test("幻之寶可夢先顯示稀有度，同形態不同寫法歸入同一收藏組", () => {
  const snapshot = fixture();
  snapshot.species.deoxys_attack = species("deoxys_attack", {
    form: "(Attack)", tags: ["mythical"],
  });
  const target = snapshot.species.deoxys_attack;
  const evaluated = evaluateCollection(
    ([["攻擊形態", [15, 15, 14]], ["(Attack)", [15, 14, 13]], ["attack", [12, 12, 12]]] as const)
      .map(([form, iv], index) => record(`deoxys-${index}`, {
        speciesId: "deoxys_attack", form,
        ivAtk: iv[0], ivDef: iv[1], ivSta: iv[2],
        cp: combatPower(target, [...iv], 20, snapshot),
        hp: hitPoints(target, iv[2], 20, snapshot),
      })),
    snapshot, { ...settings, raidSlots: 0, rareRepresentatives: 1 },
  );
  assert.ok(evaluated.every((pokemon) => pokemon.analysis?.category === "collect"));
  assert.ok(evaluated.every((pokemon) =>
    pokemon.analysis?.reasons[0] === "幻之寶可夢，保留且不列入放生候選",
  ));
  const reasons = evaluated.map((pokemon) => pokemon.analysis?.reasons || []);
  assert.deepEqual(reasons.map((r) => r.includes("形態「攻擊形態」收藏代表（同組前 1 名）")), [true, false, false]);
  assert.deepEqual(reasons.map((r) => r.some((x) => x.includes("高 IV 收藏代表"))), [true, false, false]);
});

test("掃描到「普通」等一般形態寫法時歸入同一收藏組", () => {
  const snapshot = fixture();
  snapshot.species.charmander = species("charmander");
  const evaluated = evaluateCollection(
    [null, "一般", "普通", " Normal "].map((form, index) => record(`plain-${index}`, {
      speciesId: "charmander", form, costume: "南瓜帽",
    })),
    snapshot, { ...settings, rareRepresentatives: 1 },
  );
  assert.equal(evaluated.filter((p) =>
    p.analysis?.reasons.includes("服裝「南瓜帽」收藏代表（同組前 1 名）"),
  ).length, 1);
});

test("未登錄進化剪影與已匯入收藏缺少下一階即列為可進化", () => {
  const snapshot = fixture();
  snapshot.species.caterpie.evolutions = [
    { id: "metapod", candy: 12, condition: null },
  ];
  snapshot.species.metapod = species("metapod");
  const first = record("unevolved", { favorite: false }, { evolutionSilhouette: true });
  const fullBox = new Set([first.id]);
  assert.equal(
    evaluateCollection([first], snapshot, settings, fullBox)[0].analysis?.category,
    "evolve",
  );
  const incompleteBox = evaluateCollection([first], snapshot, settings)[0];
  assert.equal(incompleteBox.analysis?.category, "evolve");
  assert.match(incompleteBox.analysis?.reasons.join(" ") || "", /已匯入且仍持有的收藏（盒子掃描未完成）/);
  assert.ok(transferExclusion(incompleteBox, snapshot));
  const unknown = evaluateCollection(
    [{ ...first, evolutionSilhouette: null }], snapshot, settings, fullBox,
  )[0];
  assert.equal(unknown.analysis?.category, "review");
  assert.match(unknown.analysis?.reasons[0] || "", /進化剪影尚未判定/);
  const unavailable = evaluateCollection(
    [{ ...first, evolutionSilhouette: "unavailable" }], snapshot, settings, fullBox,
  )[0];
  assert.notEqual(unavailable.analysis?.category, "review");
  assert.notEqual(unavailable.analysis?.category, "evolve");
  assert.ok(unavailable.analysis?.reasons.includes("已人工確認此個體沒有進化按鈕"));
  const costumed = evaluateCollection(
    [record("costumed", { costume: "特殊造型" }, { evolutionSilhouette: "unavailable" })],
    snapshot, settings, new Set(["costumed"]),
  )[0];
  assert.equal(costumed.analysis?.category, "collect");
  snapshot.species.eevee = species("eevee", {
    evolutions: [
      { id: "vaporeon", candy: 25, condition: null },
      { id: "jolteon", candy: 25, condition: null },
    ],
  });
  snapshot.species.vaporeon = species("vaporeon");
  snapshot.species.jolteon = species("jolteon");
  const eevee = record("eevee", { speciesId: "eevee" }, {
    evolutionSilhouette: "unknown-branch",
  });
  const uncertainBranch = evaluateCollection(
    [eevee], snapshot, settings, new Set([eevee.id]),
  )[0];
  assert.equal(uncertainBranch.analysis?.category, "collect");
  assert.match(uncertainBranch.analysis?.reasons.join(" ") || "", /進化結果不明/);
  assert.ok(transferExclusion(uncertainBranch, snapshot));
  const evolved = record("evolved", { speciesId: "metapod" });
  assert.equal(
    evaluateCollection(
      [first, evolved],
      snapshot,
      settings,
      new Set([first.id, evolved.id]),
    )[0].analysis?.category,
    "review",
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
  const another = record("another-branch", { favorite: false }, { evolutionSilhouette: true });
  const ranked = evaluateCollection(
    [first, another], snapshot, settings, new Set([first.id, another.id]),
  );
  assert.equal(ranked.filter((pokemon) => pokemon.analysis?.category === "evolve").length, 1);
  const duplicate = ranked.find((pokemon) => pokemon.analysis?.category !== "evolve")!;
  assert.equal(duplicate.analysis?.category, "transfer");
  assert.equal(transferExclusion(duplicate, snapshot), null);
  const staleTransfer = { ...first, analysis: { ...duplicate.analysis!, reasons: [] } };
  assert.match(transferExclusion(staleTransfer, snapshot) || "", /未登錄進化剪影/);
});

test("最終進化型的超級進化或原始回歸剪影推薦同類最佳一隻，其餘照常評估", () => {
  const snapshot = fixture();
  snapshot.species.caterpie.mega = true;
  // Equal individuals rank by ID, so mega-a is the one to Mega Evolve.
  const first = record("mega-a", { favorite: false }, { evolutionSilhouette: true });
  const second = record("mega-b", { favorite: false }, { evolutionSilhouette: true });
  const [winner, peer] = evaluateCollection(
    [second, first], snapshot, settings, new Set([first.id, second.id]),
  ).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(winner.analysis?.category, "evolve");
  assert.equal(winner.analysis?.reasons[0], "超級進化按鈕顯示未登錄剪影；同類中優先超級進化這隻");
  assert.equal(winner.analysis?.actions[0], "可考慮超級進化以登錄圖鑑。");
  assert.equal(winner.analysis?.evolutionCandy, null);
  assert.equal(peer.analysis?.category, "transfer");
  assert.ok(peer.analysis?.reasons.includes("同類已有更適合進化的個體"));
  assert.equal(transferExclusion(peer, snapshot), null);
  const shadow = record("mega-shadow", { favorite: false, shadow: true }, { evolutionSilhouette: true });
  assert.equal(evaluateCollection([shadow], snapshot, settings)[0].analysis?.category, "review");
  snapshot.species.kyogre = species("kyogre", { mega: true });
  const kyogre = record("primal", { speciesId: "kyogre", favorite: false }, { evolutionSilhouette: true });
  assert.equal(evaluateCollection([kyogre], snapshot, settings)[0].analysis?.reasons[0],
    "原始回歸按鈕顯示未登錄剪影；同類中優先原始回歸這隻");
});

test("外觀形態（花色、海域）各算一個形態收藏代表，進化也依形態判斷", () => {
  const snapshot = fixture();
  snapshot.visualForms = { 10: [{ id: "red", label: "紅花" }, { id: "blue", label: "藍花" }] };
  const flower = (id: string, form: string | null, other: Partial<Pokemon> = {}) =>
    record(id, { favorite: false, form }, other);
  const byId = new Map(evaluateCollection(
    [flower("red-label", "紅花"), flower("red-id", "red"), flower("blue", "藍花"), flower("plain", null)],
    snapshot, { ...settings, rareRepresentatives: 1 },
  ).map((p) => [p.id, p.analysis!]));
  assert.deepEqual(byId.get("blue")!.collectionKeys.map((k) => k.label), ["形態「藍花」"]);
  assert.equal(byId.get("blue")!.category, "collect");
  // The stored label and the stored ID name the same flower, so they share one slot.
  assert.equal(["red-label", "red-id"].filter((id) =>
    byId.get(id)!.reasons.includes("形態「紅花」收藏代表（同組前 1 名）")).length, 1);
  assert.deepEqual(byId.get("plain")!.collectionKeys, []);

  snapshot.species.caterpie.evolutions = [{ id: "metapod", candy: 12, condition: null }];
  snapshot.species.metapod = species("metapod");
  const blueBud = flower("blue-bud", "藍花", { evolutionSilhouette: true });
  const redBud = flower("red-bud", "紅花", { evolutionSilhouette: true });
  const evolved = (form: string) => record(`evolved-${form}`, { speciesId: "metapod", form });
  const categories = (pokemon: Pokemon[]) => evaluateCollection(
    pokemon, snapshot, settings, new Set(pokemon.map((p) => p.id)),
  ).map((p) => p.analysis?.category);
  assert.equal(categories([blueBud, evolved("紅花")])[0], "evolve");
  assert.equal(categories([blueBud, evolved("blue")])[0], "review");
  assert.deepEqual(categories([blueBud, redBud]), ["evolve", "evolve"]);
  const undecided = evaluateCollection(
    [flower("blue-unknown", "藍花"), evolved("紅花")], snapshot, settings,
  )[0];
  assert.match(undecided.analysis?.reasons[0] || "", /進化剪影尚未判定/);
});

test("可進化個體比較持有糖果與進化成本，成本只取遊戲資料，分支成本不同時分開列出", () => {
  const snapshot = fixture();
  snapshot.species.caterpie.evolutions = [
    { id: "metapod", candy: 12, candyPurified: 10, condition: null },
  ];
  snapshot.species.metapod = species("metapod");
  const assessCandy = (id: string, candy: number | null, purified = false) =>
    evaluateCollection([
      record(id, { candy, purified, favorite: false }, { evolutionSilhouette: true }),
    ], snapshot, settings)[0].analysis;
  const required = (...args: Parameters<typeof assessCandy>) =>
    assessCandy(...args)?.evolutionCandy?.options[0].required;
  assert.deepEqual(assessCandy("short", 8)?.evolutionCandy, {
    available: 8,
    options: [{ speciesId: "metapod", name: "metapod", required: 12, condition: null }],
  });
  assert.equal(assessCandy("enough", 60)?.evolutionCandy?.available, 60);
  assert.equal(assessCandy("unknown", null)?.evolutionCandy?.available, null);
  assert.equal(required("purified", 11, true), 10);
  const purified = record("x", { purified: true }).fields;
  assert.equal(evolutionPaths(snapshot.species.caterpie, purified, snapshot)[1].candy, 10);
  snapshot.species.caterpie.evolutions = [{ id: "metapod", candy: 12, condition: null }];
  assert.equal(required("purified-estimate", 11, true), 11);
  snapshot.species.caterpie.evolutions = [
    { id: "metapod", candy: 12, condition: null },
    { id: "butterfree", candy: 50, condition: "道具" },
  ];
  snapshot.species.butterfree = species("butterfree");
  const branches = assessCandy("branches", 30)?.evolutionCandy?.options;
  assert.deepEqual(branches?.map((option) => option.required), [12, 50]);
  assert.equal(branches?.[1].condition, "道具");
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

test("大面積粉色剪影、低信心文字與漏讀進化標籤仍可區分已登錄圖像", async () => {
  const make = async (name: string, button: string, icon: string) => {
    const file = path.join(temp, name);
    const svg = Buffer.from(`<svg width="600" height="926" xmlns="http://www.w3.org/2000/svg">
      <rect width="600" height="926" fill="white"/>
      <rect x="40" y="430" width="240" height="80" fill="${button}"/>
      <rect x="110" y="450" width="40" height="35" fill="${icon}"/>
    </svg>`);
    await sharp(svg).png().toFile(file);
    return file;
  };
  const pink = await make("large-pink-silhouette.png", "#ffcae8", "#bf93aa");
  const green = await make("low-confidence-silhouette.png", "#9dd7b3", "#54866e");
  const registered = await make("registered-evolution.png", "#9dd7b3", "#808080");
  const evolve = { text: "進化", confidence: 0.3, x: 0.29, y: 0.4665 };
  assert.equal(await evolutionSilhouette(pink, [{ ...evolve, confidence: 0.5 }]), true);
  assert.equal(await evolutionSilhouette(green, [evolve]), true);
  assert.equal(await evolutionSilhouette(registered, [evolve]), false);
  assert.equal(await evolutionSilhouette(registered, [evolve], true), null);
  const fallback = [
    { text: "強化", confidence: 0.5, x: 0.23, y: 0.5585 },
    { text: "50", confidence: 0.5, x: 0.7, y: 0.4665 },
  ];
  assert.equal(await evolutionSilhouette(green, fallback), true);
  assert.equal(await evolutionSilhouette(registered, fallback), false);
  assert.equal(await evolutionSilhouette(green, fallback.slice(0, 1)), null);
});

test("進化問號與沒有進化列須有完整 OCR 位置證據", async () => {
  const file = path.join(temp, "evolution-button-states.png");
  await sharp({ create: { width: 600, height: 900, channels: 3, background: "white" } })
    .png().toFile(file);
  const line = (text: string, x: number, y: number) =>
    ({ text, x, y, confidence: 0.5 });
  const evolve = line("進化", 0.29, 0.48);
  assert.equal(await evolutionSilhouette(file, [evolve, line("？", 0.19, 0.47)], true),
    "unknown-branch");
  assert.equal(await evolutionSilhouette(file, [evolve, line("？", 0.19, 0.3)], true), null);
  const powerUp = line("強化", 0.23, 0.46);
  const newMove = line("新攻擊招式", 0.16, 0.16);
  assert.equal(await evolutionSilhouette(file, [powerUp, newMove]), "unavailable");
  assert.equal(await evolutionSilhouette(file, [powerUp]), null);
  assert.equal(await evolutionSilhouette(file, [powerUp, { ...newMove, y: 0.05 }]), null);
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

test("徽章區像素與能力頁欄位互證，容忍 CP 或星塵 OCR 漏字", () => {
  const line = (text: string, y: number, x = 0.4) =>
    ({ text, y, x, confidence: 0.9 });
  const page = [line("106/106 HP", 0.48), line("31.93kg", 0.4, 0.13),
    line("1.52m", 0.4, 0.74), line("星星沙子", 0.27, 0.2),
    line("強化", 0.05, 0.22)];
  assert.equal(maxStatusFromEvidence(page, { pink: 0, white: 0.92 }), "none");
  assert.equal(maxStatusFromEvidence([
    ...page.slice(0, 3), line("CP409", 0.9), line("地面／幽靈", 0.38),
  ], { pink: 0, white: 0.94 }), "none");
  assert.equal(maxStatusFromEvidence(page, { pink: 0, white: 0 }), null);
  assert.equal(maxStatusFromEvidence(page, { pink: 0.22, white: 0.72 }), null);
  assert.equal(maxStatusFromEvidence([...page, line("極巨化", 0.3)],
    { pink: 0.22, white: 0.72 }), "dynamax");
  assert.equal(maxStatusFromEvidence([...page, line("超極巨化", 0.3)],
    { pink: 0.22, white: 0.72 }), "gigantamax");
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

test("物種未開放極巨化或個體為暗影、淨化時，未確認的極巨化狀態視為一般", () => {
  const outcome = (maxForms?: ("dynamax" | "gigantamax")[], patch: { purified?: boolean } = {}) => {
    const snapshot = fixture();
    snapshot.species.caterpie.maxForms = maxForms;
    const [p] = evaluateCollection(
      [record("unknown", { favorite: false, ...patch }, { maxStatus: null })], snapshot, settings,
    );
    return [p.analysis?.category, transferExclusion(p, snapshot)];
  };
  assert.deepEqual(outcome([]), ["transfer", null]);
  assert.deepEqual(outcome(["dynamax"]), ["review", "目前不屬於可放生建議"]);
  assert.deepEqual(outcome(undefined), ["review", "目前不屬於可放生建議"]);
  assert.deepEqual(outcome(["dynamax"], { purified: true }), ["transfer", null]);
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
test("開招成本取遊戲資料：暗影 1.2 倍、淨化 0.8 倍，不用畫面讀值", () => {
  const s = fixture();
  s.species.caterpie_shadow = species("caterpie_shadow", { tags: ["shadow"] });
  s.rankings["1500"] = ["caterpie", "caterpie_shadow"].map((speciesId) =>
    ({ speciesId, score: 100, moves: ["BUG_BITE", "STRUGGLE"] }));
  const unlock = (id: string, patch: Partial<Fields> = {}) => evaluateCollection([record(id, {
    ivAtk: 15,
    ivDef: 15,
    ivSta: 15,
    cp: combatPower(s.species.caterpie, [15, 15, 15], 15, s),
    hp: hitPoints(s.species.caterpie, 15, 15, s),
    fastMove: "BUG_BITE",
    chargeMove: "STRUGGLE",
    ...patch,
  })], s, settings)[0].analysis?.actions.find((x) => x.startsWith("PvP 通常需第二特殊招式"));
  assert.equal(unlock("regular"), "PvP 通常需第二特殊招式；開招需 10,000 星塵及 25 糖果。");
  assert.match(unlock("shadow", { speciesId: "caterpie_shadow", shadow: true }) ?? "", /開招需 12,000 星塵及 30 糖果/);
  assert.match(unlock("purified", { purified: true }) ?? "", /開招需 8,000 星塵及 20 糖果/);
  s.species.caterpie.thirdMove = null;
  assert.match(unlock("no-unlock") ?? "", /請核對遊戲中的開招成本/);
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
  s.species.caterpie_shadow = species("caterpie_shadow", {
    tags: ["shadow"],
    purification: { dust: 3000, candy: 3 },
  });
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
  assert.deepEqual(a.purification?.cost, { dust: 3000, candy: 3 });
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
test("完整備份可還原個體與遊戲資料快照（含 Mega、極巨化、淨化與外觀形態），重複匯入不覆蓋人工修正", async () => {
  const snapshot = fixture();
  snapshot.species.caterpie = species("caterpie", {
    mega: true,
    maxForms: ["dynamax", "gigantamax"],
    purification: { dust: 3000, candy: 3 },
  });
  snapshot.visualForms = { "10": [{ id: "caterpie_party_hat", label: "派對帽" }] };
  store.saveSnapshot(snapshot);
  const p = record("backup", {}, { maxStatus: "dynamax" });
  store.put("pokemon", p.id, p);
  const backup = await exportBackup();
  store.remove("pokemon", p.id);
  store.remove("settings", "snapshot");
  assert.equal((await importBackup(backup)).imported, 1);
  assert.equal(store.get<PokemonType>("pokemon", p.id)?.maxStatus, "dynamax");
  assert.deepEqual(store.getSnapshot(), snapshot);
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
      version: 2,
      pokemon: [],
      observations: [],
      settings,
      snapshot: null,
      frames: { "../secret": "abc" },
      scans: [],
      scanItems: [],
      transferBatches: [],
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

test("物種目錄包含脫殼忍者與已知形態，補上文字檔缺少的中文名，仍排除一般未開放資料", async () => {
  const { normalizeData, addCatalogForms } = await import("../src/lib/game-data");
  const base = (id: string, dex: number, released: boolean) => ({
    speciesId: id, speciesName: id, dex, released,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [],
  });
  const pokemon = Array.from({ length: 100 }, (_, index) =>
    base(`fixture_${index}`, index + 1, true));
  pokemon.push(base("shedinja", 292, false), base("ditto", 132, false),
    base("cosmog", 789, false), base("cosmoem", 790, false), base("unreleased_fixture", 9999, false),
    base("dipplin", 1011, true));
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const normalized = normalizeData({ pokemon, moves: [] }, gm,
    "RESOURCE ID: pokemon_name_0292\nTEXT: 脫殼忍者", ranks, "test-version");
  assert.equal(normalized.species.shedinja.name, "脫殼忍者");
  assert.equal(normalized.species.dipplin.name, "裹蜜蟲");
  assert.ok(normalized.species.ditto);
  assert.ok(normalized.species.cosmog);
  assert.ok(normalized.species.cosmoem);
  assert.equal(normalized.species.unreleased_fixture, undefined);
  normalized.species.nidoran_male = species("nidoran_male", { dex: 32, name: "尼多朗" });
  normalized.species.squawkabilly = species("squawkabilly", { dex: 931, name: "怒鸚哥" });
  addCatalogForms(normalized.species);
  assert.equal(normalized.species.nidoran_m.dex, 32);
  assert.equal(normalized.species.squawkabilly_green.name, "怒鸚哥（綠羽）");
});

test("遊戲資料記錄每個物種可能的性別，性別形態依自己的 ID 固定", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number) => ({
    speciesId: id, speciesName: id, dex, released: true,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [],
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    base("pikachu", 25), base("magnemite", 81), base("magnemite_shadow", 81), base("tauros", 128),
    base("meowstic", 678), base("meowstic_female", 678), base("indeedee_male", 876),
  ];
  const gender = (dex: number, form: string, ratio: Record<string, number>) => ({
    templateId: `SPAWN_V${String(dex).padStart(4, "0")}_POKEMON_${form}`,
    data: { genderSettings: { gender: ratio } },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    gender(25, "PIKACHU", { malePercent: 0.5, femalePercent: 0.5 }),
    gender(25, "PIKACHU_POP_STAR", { femalePercent: 1 }),
    gender(81, "MAGNEMITE", { genderlessPercent: 1 }),
    gender(128, "TAUROS", { malePercent: 1 }),
    gender(128, "TAUROS_PALDEA_COMBAT", { malePercent: 1 }),
    gender(678, "MEOWSTIC", { malePercent: 1 }),
    gender(678, "MEOWSTIC_FEMALE", { femalePercent: 1 }),
    gender(876, "INDEEDEE_MALE", { malePercent: 1 }),
    gender(876, "INDEEDEE_FEMALE", { femalePercent: 1 }),
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const { species: result } = normalizeData({ pokemon, moves: [] }, gm, "", ranks, "test-version");
  const genders = (id: string) => [result[id].genders, result[id].genderless];
  assert.deepEqual(genders("pikachu"), [["male", "female"], false]);
  assert.deepEqual(genders("magnemite"), [["genderless"], true]);
  assert.deepEqual(genders("magnemite_shadow"), [["genderless"], true]);
  assert.deepEqual(genders("tauros"), [["male"], false]);
  assert.deepEqual(genders("meowstic"), [["male"], false]);
  assert.deepEqual(genders("meowstic_female"), [["female"], false]);
  assert.deepEqual(genders("indeedee_male"), [["male"], false]);
  assert.deepEqual(genders("fixture_0"), [undefined, false]);
});

test("更新資料時列出 Game Master 招式池有、PvPoke 尚未收錄的招式", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number, moves: Record<string, string[]> = {}) => ({
    speciesId: id, speciesName: id, dex, released: true,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [], ...moves,
    ...(id.endsWith("_shadow") && { tags: ["shadow"] }),
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    base("grimer", 88, { fastMoves: ["MUD_SLAP"], eliteMoves: ["ACID"] }),
    base("maschiff", 942, { fastMoves: ["BITE"], chargedMoves: ["CRUNCH"] }),
    base("maschiff_shadow", 942, { fastMoves: ["BITE"], chargedMoves: ["CRUNCH"] }),
    base("aegislash_shield", 681, { chargedMoves: ["AEGISLASH_CHARGE_PSYCHO_CUT"] }),
  ];
  const settings = (template: string, moves: Record<string, unknown[]>) => ({
    templateId: template, data: { pokemonSettings: moves },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    settings("V0088_POKEMON_GRIMER", { quickMoves: ["MUD_SLAP_FAST"] }),
    settings("V0942_POKEMON_MASCHIFF", { quickMoves: ["BITE_FAST"], cinematicMoves: ["CRUNCH", "PAYBACK", 497] }),
    settings("V0681_POKEMON_AEGISLASH_SHIELD", { cinematicMoves: ["PSYCHO_CUT"] }),
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const { warnings } = normalizeData({ pokemon, moves: [] }, gm, "", ranks, "test-version");
  const gaps = warnings.filter((warning) => warning.includes("PvPoke 尚未收錄"));
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /：maschiff PAYBACK$/);
});

test("截圖的招式名稱對應多個代號時，依物種招式池選出唯一代號", async () => {
  const { resolveMoveId } = await import("../src/lib/game-data");
  const snapshot = fixture();
  const move = (id: string, name: string) => ({ id, name, type: "water", power: 5, energy: 5, duration: 0.5 });
  snapshot.moves.WATER_GUN = move("WATER_GUN", "水槍");
  snapshot.moves.WATER_GUN_FAST_BLASTOISE = move("WATER_GUN_FAST_BLASTOISE", "水槍");
  snapshot.moves.OUTRAGE = move("OUTRAGE", "逆麟");
  const squirtle = species("squirtle", { fast: ["WATER_GUN", "TACKLE"] });
  assert.equal(resolveMoveId(snapshot, "水槍", squirtle), "WATER_GUN");
  assert.equal(resolveMoveId(snapshot, "水槍"), "水槍");
  assert.equal(resolveMoveId(snapshot, "水槍", species("both", { fast: ["WATER_GUN", "WATER_GUN_FAST_BLASTOISE"] })), "水槍");
  assert.equal(resolveMoveId(snapshot, "蟲咬"), "BUG_BITE");
  assert.equal(resolveMoveId(snapshot, "BUG_BITE"), "BUG_BITE");
  assert.equal(resolveMoveId(snapshot, "逆鱗"), "OUTRAGE");
  assert.equal(resolveMoveId(snapshot, "不存在的招式", squirtle), "不存在的招式");
});

test("PvPoke 招式代號對應到 Game Master 的招式數值", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number, moves: Record<string, string[]> = {}) => ({
    speciesId: id, speciesName: id, dex, released: true,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [], ...moves,
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    base("espeon", 196, { fastMoves: ["HIDDEN_POWER_BUG"], chargedMoves: ["FUTURE_SIGHT"], eliteMoves: ["FUTURE_SIGHT"] }),
    base("genesect_douse", 649, { chargedMoves: ["TECHNO_BLAST_DOUSE", "PLASMA_FISTS"] }),
    base("aegislash_shield", 681, { fastMoves: ["AEGISLASH_CHARGE_PSYCHO_CUT"] }),
  ];
  const move = (template: string, movementId: string | number, type: string) => ({
    templateId: template,
    data: { moveSettings: { movementId, pokemonType: `POKEMON_TYPE_${type}`, power: 100, energyDelta: -50, durationMs: 2000 } },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    move("V0275_MOVE_FUTURESIGHT", "FUTURESIGHT", "PSYCHIC"),
    move("V0281_MOVE_HIDDEN_POWER_FAST", "HIDDEN_POWER_FAST", "NORMAL"),
    move("V0339_MOVE_TECHNO_BLAST_WATER", "TECHNO_BLAST_WATER", "WATER"),
    move("V0497_MOVE_PLASMA_FISTS", 497, "ELECTRIC"),
    move("V0012_MOVE_PSYCHO_CUT_FAST", "PSYCHO_CUT_FAST", "PSYCHIC"),
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) => [cap, [
    { speciesId: "espeon", score: 2, moveset: ["HIDDEN_POWER_BUG", "FUTURE_SIGHT"] },
    ...Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 })),
  ]]));
  const snapshot = normalizeData(
    { pokemon, moves: [{ moveId: "HIDDEN_POWER_BUG", type: "bug" }] }, gm, "", ranks, "test-version",
  );
  const { species, moves, rankings } = snapshot;
  assert.deepEqual(species.espeon.charged, ["FUTURESIGHT"]);
  assert.deepEqual(species.espeon.elite, ["FUTURESIGHT"]);
  assert.deepEqual(species.genesect_douse.charged, ["TECHNO_BLAST_WATER", "PLASMA_FISTS"]);
  assert.deepEqual(species.aegislash_shield.fast, ["PSYCHO_CUT"]);
  assert.deepEqual(rankings["1500"][0].moves, ["HIDDEN_POWER_BUG", "FUTURESIGHT"]);
  assert.equal(moves.PLASMA_FISTS.type, "electric");
  assert.equal(moves.HIDDEN_POWER.type, "normal");
  assert.equal(moves.HIDDEN_POWER_BUG.type, "bug");
  assert.equal(moves.HIDDEN_POWER_BUG.name, "覺醒力量（蟲）");
  for (const s of Object.values(species))
    for (const id of [...s.fast, ...s.charged, ...s.elite]) assert.ok(moves[id], id);
});

test("性別分歧的進化依性別對應各自的路線與物種 ID；讀取淨化個體的進化成本、淨化成本與開第二招成本", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number, evolutions?: string[]) => ({
    speciesId: id, speciesName: id, dex, released: true,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [], ...(evolutions && { family: { evolutions } }),
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    // PvPoke lists both genders of a gender split under the plain ID.
    base("espurr", 677, ["meowstic", "meowstic"]), base("meowstic", 678), base("meowstic_female", 678),
    base("litleo", 667, ["pyroar", "pyroar"]), base("pyroar", 668),
    base("snorunt", 361, ["froslass", "glalie"]), base("froslass", 478), base("glalie", 362),
    base("smeargle", 235),
  ];
  const branches = (dex: number, name: string, evolutionBranch: Record<string, unknown>[], extra = {}) => ({
    templateId: `V${String(dex).padStart(4, "0")}_POKEMON_${name}`,
    data: { pokemonSettings: { evolutionBranch, ...extra } },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    branches(677, "ESPURR", [
      { evolution: "MEOWSTIC", candyCost: 50, form: "MEOWSTIC_NORMAL", genderRequirement: "MALE" },
      { evolution: "MEOWSTIC", candyCost: 50, form: "MEOWSTIC_FEMALE", genderRequirement: "FEMALE" },
    ]),
    branches(667, "LITLEO", [
      { evolution: "PYROAR", candyCost: 50, form: "PYROAR_NORMAL", genderRequirement: "MALE" },
      { evolution: "PYROAR", candyCost: 50, form: "PYROAR_FEMALE", genderRequirement: "FEMALE" },
    ]),
    branches(361, "SNORUNT", [
      { evolution: "FROSLASS", candyCost: 100, genderRequirement: "FEMALE" },
      { evolution: "GLALIE", candyCost: 100, candyCostPurified: 90 },
    ], {
      shadow: { purificationStardustNeeded: 3000, purificationCandyNeeded: 3 },
      thirdMove: { stardustToUnlock: 10000, candyToUnlock: 25 },
    }),
    // Smeargle cannot unlock a second move; the Game Master lists only an unreachable candy cost.
    branches(235, "SMEARGLE", [], { thirdMove: { candyToUnlock: 9999999 } }),
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const { species: result } = normalizeData({ pokemon, moves: [] }, gm, "", ranks, "test-version");
  const evolutions = (id: string) => result[id].evolutions.map((e) => [e.id, e.gender]);
  assert.deepEqual(evolutions("espurr"), [["meowstic", "male"], ["meowstic_female", "female"]]);
  // Pyroar has no separate female ID, so both genders evolve into the same species.
  assert.deepEqual(evolutions("litleo"), [["pyroar", "male"], ["pyroar", "female"]]);
  assert.deepEqual(evolutions("snorunt"), [["froslass", "female"], ["glalie", undefined]]);
  assert.deepEqual(result.snorunt.evolutions.map((e) => e.candyPurified), [undefined, 90]);
  assert.deepEqual(result.snorunt.purification, { dust: 3000, candy: 3 });
  assert.equal(result.espurr.purification, undefined);
  assert.deepEqual(result.snorunt.thirdMove, { dust: 10000, candy: 25 });
  assert.equal(result.smeargle.thirdMove, null);
});

test("PvPoke 拼錯的鬃岩狼人（黃昏）對應到遊戲資料中我行我素岩狗狗的進化", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number, evolutions?: string[]) => ({
    speciesId: id, speciesName: id, dex, released: true,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["rock", "none"],
    fastMoves: [], chargedMoves: [], ...(evolutions && { family: { evolutions } }),
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    base("rockruff", 744, ["lycanroc_midnight", "lycanroc_midday", "lycranroc_dusk"]),
    base("lycanroc_midday", 745), base("lycanroc_midnight", 745), base("lycanroc_dusk", 745),
  ];
  const rockruff = (form: string, evolutionBranch: Record<string, unknown>[]) => ({
    templateId: `V0744_POKEMON_${form}`,
    data: { pokemonSettings: { form, evolutionBranch } },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: { playerLevel: { cpMultiplier: Array(51).fill(0.5) } } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    rockruff("ROCKRUFF_DUSK", [
      { evolution: "LYCANROC", candyCost: 50, form: "LYCANROC_DUSK", onlyDuskPeriod: true },
    ]),
    rockruff("ROCKRUFF_NORMAL", [
      { evolution: "LYCANROC", candyCost: 50, form: "LYCANROC_MIDDAY", onlyDaytime: true },
      { evolution: "LYCANROC", candyCost: 50, form: "LYCANROC_MIDNIGHT", onlyNighttime: true },
    ]),
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const { species: result } = normalizeData({ pokemon, moves: [] }, gm, "", ranks, "test-version");
  assert.deepEqual(result.rockruff.evolutions.map((e) => [e.id, e.candy, e.condition]), [
    ["lycanroc_midnight", 50, "有時段限制"],
    ["lycanroc_midday", 50, "有時段限制"],
    ["lycanroc_dusk", 50, "只有特定形態的個體能進化；有時段限制"],
  ]);
});

test("遊戲資料標記可 Mega 進化或原始回歸的物種", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number, tags?: string[]) => ({
    speciesId: id, speciesName: id, dex, released: true, tags,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [],
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    base("kyogre", 382), base("snorlax", 143), base("tauros", 128),
    base("staraptor", 398), base("staraptor_mega", 398, ["mega"]),
  ];
  const settings = (dex: number, name: string, tempEvoOverrides: Record<string, unknown>[]) => ({
    templateId: `V${String(dex).padStart(4, "0")}_POKEMON_${name}`,
    data: { pokemonSettings: { tempEvoOverrides } },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    settings(382, "KYOGRE", [{ tempEvoId: "TEMP_EVOLUTION_PRIMAL" }]),
    // An override without a temporary evolution, as Gengar's extra entry has.
    settings(143, "SNORLAX", [{}]),
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const { species: result } = normalizeData({ pokemon, moves: [] }, gm, "", ranks, "test-version");
  assert.deepEqual(["kyogre", "staraptor", "snorlax", "tauros"].map((id) => result[id].mega),
    [true, true, false, false]);
  assert.equal(result.staraptor_mega, undefined);
});

test("遊戲資料依極巨對戰模型標記可極巨化與超極巨化的物種", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number) => ({
    speciesId: id, speciesName: id, dex, released: true,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [],
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    base("charmander", 4), base("charizard", 6), base("charizard_shadow", 6),
    base("meowth_galarian", 52), base("urshifu_single_strike", 892), base("zacian_hero", 888),
  ];
  const extended = (dex: number, name: string, modes: string[]) => ({
    templateId: `EXTENDED_V${String(dex).padStart(4, "0")}_POKEMON_${name}`,
    data: { pokemonExtendedSettings: { breadOverrides: modes.map((breadMode) => ({ breadMode })) } },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    extended(4, "CHARMANDER_NORMAL", ["BREAD_MODE"]),
    extended(6, "CHARIZARD", ["BREAD_MODE", "BREAD_DOUGH_MODE"]),
    extended(52, "MEOWTH_GALARIAN", ["BREAD_MODE"]),
    extended(892, "URSHIFU_SINGLE_STRIKE", ["BREAD_MODE", "BREAD_DOUGH_MODE_2"]),
    { templateId: "V0888_POKEMON_ZACIAN_HERO", data: { pokemonSettings: { formChange: [
      { formChangeBonusAttributes: [{ breadMode: "BREAD_SPECIAL_MODE" }] },
    ] } } },
  ];
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const { species: result } = normalizeData({ pokemon, moves: [] }, gm, "", ranks, "test-version");
  assert.deepEqual(
    ["charmander", "charizard", "charizard_shadow", "meowth_galarian", "urshifu_single_strike", "zacian_hero", "fixture_0"]
      .map((id) => result[id].maxForms),
    [["dynamax"], ["dynamax", "gigantamax"], ["dynamax", "gigantamax"], ["dynamax"],
      ["dynamax", "gigantamax"], ["dynamax"], []],
  );
  const { species: old } = normalizeData({ pokemon, moves: [] }, gm.slice(0, 2), "", ranks, "test-version");
  assert.equal(old.charizard.maxForms, undefined);
});

test("遊戲資料收集外觀形態，略過服裝、戰鬥中形態與已有物種 ID 的形態", async () => {
  const { normalizeData } = await import("../src/lib/game-data");
  const base = (id: string, dex: number) => ({
    speciesId: id, speciesName: id, dex, released: true,
    baseStats: { atk: 100, def: 100, hp: 100 }, types: ["normal", "none"],
    fastMoves: [], chargedMoves: [],
  });
  const pokemon = [
    ...Array.from({ length: 100 }, (_, index) => base(`fixture_${index}`, index + 1)),
    base("tauros", 128), base("tauros_combat", 128), base("unown", 201), base("raikou", 243),
    base("shellos", 422), base("rockruff", 744), base("mimikyu", 778),
  ];
  const forms = (dex: number, name: string, rows: Record<string, unknown>[]) => ({
    templateId: `FORMS_V${String(dex).padStart(4, "0")}_POKEMON_${name}`,
    data: { formSettings: { pokemon: name, forms: rows } },
  });
  const gm = [
    { templateId: "PLAYER_LEVEL_SETTINGS", data: {
      playerLevel: { cpMultiplier: Array(51).fill(0.5) },
    } },
    { templateId: "POKEMON_UPGRADE_SETTINGS", data: {
      pokemonUpgrades: { stardustCost: [1000], candyCost: [1], xlCandyCost: [1] },
    } },
    forms(128, "TAUROS", [{ form: "TAUROS_NORMAL" }, { form: "TAUROS_PALDEA_COMBAT" }]),
    forms(201, "UNOWN", [
      { form: "UNOWN_F", assetBundleValue: 16 }, { form: "UNOWN_A", assetBundleValue: 11 },
      { form: "UNOWN_S", assetBundleValue: 29 }, { form: "UNOWN_HAT", isCostume: true },
    ]),
    forms(243, "RAIKOU", [{ form: "RAIKOU_NORMAL" }, { form: "RAIKOU_S" }]),
    forms(422, "SHELLOS", [
      { form: "SHELLOS_EAST_SEA", assetBundleValue: 12 },
      { form: "SHELLOS_WEST_SEA", assetBundleValue: 11 },
    ]),
    forms(744, "ROCKRUFF", [{ form: "ROCKRUFF_NORMAL" }, { form: "ROCKRUFF_DUSK" }]),
    forms(778, "MIMIKYU", [{ form: "MIMIKYU_DISGUISED" }, { form: "MIMIKYU_BUSTED" }]),
  ];
  const texts = [
    ["form_east_sea", "東海"], ["form_west_sea", "西海"], ["form_dusk", "黃昏的樣子"],
    ["form_disguised", "Disguised Form"],
  ].map(([id, text]) => `RESOURCE ID: ${id}\nTEXT: ${text}`).join("\n");
  const ranks = Object.fromEntries(["1500", "2500", "10000"].map((cap) =>
    [cap, Array.from({ length: 100 }, () => ({ speciesId: "fixture_0", score: 1 }))]));
  const { visualForms } = normalizeData({ pokemon, moves: [] }, gm, texts, ranks, "test-version");
  assert.deepEqual(visualForms, {
    201: [{ id: "a", label: "A" }, { id: "f", label: "F" }, { id: "s", label: "S" }],
    422: [{ id: "west_sea", label: "西海" }, { id: "east_sea", label: "東海" }],
    744: [{ id: "normal", label: "一般" }, { id: "dusk", label: "黃昏的樣子" }],
  });
});
