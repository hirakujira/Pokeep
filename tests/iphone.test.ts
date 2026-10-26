import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fixture, record, settings } from "./fixtures";
import type { Scan, ScanItem, TransferBatch } from "../src/lib/iphone-types";
import type { IphoneMcp } from "../src/lib/iphone-mcp";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pokekeep-iphone-test-"));
(globalThis as typeof globalThis & { __POGO_TEST_DATA_DIR__?: string }).__POGO_TEST_DATA_DIR__ = temp;
const store = await import("../src/lib/store");
const safety = await import("../src/lib/iphone-safety");
const { evaluateCollection, combatPower, hitPoints } = await import("../src/lib/evaluate");
const { uniqueFormFromStats, displayForm } = await import("../src/lib/iphone-form");
const { exportBackup, importBackup } = await import("../src/lib/backup");
const { recoverInterruptedPhoneWork } =
  await import("../src/lib/iphone-recovery");
const { typeNumericSearch, typeBackgroundSearch, typeNonBackgroundSearch, authorizedTransferIndex, authorizedTransferIndexes, nextPendingUsesDex, observeGameForeground, settleAfterSubmitted } =
  await import("../src/lib/iphone-transfer");
const { cpCandidates, detailCp, searchResultCount, assertUniqueDexCp, standardTransferDialog, collectionSearchState, searchQueryMatches, backgroundQueryMatches, backgroundSearchDecision, nonBackgroundQuery, nonBackgroundQueryMatches, croppedNonBackgroundQueryMatches, croppedNonBackgroundConsensus, croppedBackgroundTextCompatible } =
  await import("../src/lib/iphone-transfer-search");
const { hasExclamationRun } = await import("../src/lib/iphone-query-glyph");
const { resumableTransferIndexes } = await import("../src/lib/iphone-resume");
const { detailFingerprint } = await import("../src/lib/iphone-fingerprint");
const { formatOcrLines } = await import("../src/lib/local-ocr");
const { processPreparedInOrder } = await import("../src/lib/ordered-prefetch");
const { shinyConsensus } = await import("../src/lib/shiny-review");
const { caughtDateBadge } = await import("../src/lib/shiny-timeline");
const { genderlessByDex } = await import("../src/lib/game-data");
const { runScan, analyzeScan, captureOne } =
  await import("../src/lib/iphone-scan");
after(() => {
  store.db().close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("相同身分必須所有欄位明確一致，未知值不能當作相同", () => {
  const a = record("a", { favorite: false }).fields;
  assert.equal(safety.samePhoneIdentity(a, { ...a }), true);
  assert.equal(safety.samePhoneIdentity(a, { ...a, hp: null }), false);
  assert.equal(
    safety.samePhoneIdentity(a, { ...a, weight: a.weight! + 0.01 }),
    false,
  );
});

test("逐隻放生只選明確授權的唯一待執行項目", () => {
  const batch = {
    mode: "single",
    selectedPokemonId: "b",
    entries: [
      { pokemonId: "a", status: "pending" },
      { pokemonId: "b", status: "pending" },
      { pokemonId: "c", status: "pending" },
    ],
  } as TransferBatch;
  assert.equal(authorizedTransferIndex(batch), 1);
  assert.deepEqual(authorizedTransferIndexes(batch), [1]);
  assert.throws(() => authorizedTransferIndex({ ...batch, mode: "bulk" }));
  assert.throws(() => authorizedTransferIndex({ ...batch, selectedPokemonId: null }));
  assert.throws(() =>
    authorizedTransferIndex({
      ...batch,
      entries: [...batch.entries, batch.entries[1]],
    }),
  );
  assert.throws(() =>
    authorizedTransferIndex({
      ...batch,
      entries: batch.entries.map((entry) =>
        entry.pokemonId === "b" ? { ...entry, status: "confirmed" } : entry,
      ),
    }),
  );
});

test("勾選批次僅可執行無重複且全部待執行的名單", () => {
  const batch = {
    mode: "bulk",
    selectedPokemonId: null,
    entries: [
      { pokemonId: "a", status: "pending" },
      { pokemonId: "b", status: "pending" },
    ],
  } as TransferBatch;
  assert.deepEqual(authorizedTransferIndexes(batch), [0, 1]);
  assert.throws(() => authorizedTransferIndexes({ ...batch, entries: [] }));
  assert.throws(() => authorizedTransferIndexes({ ...batch, entries: [...batch.entries, batch.entries[0]] }));
  assert.throws(() => authorizedTransferIndexes({
    ...batch,
    entries: [{ ...batch.entries[0], status: "sent" }, batch.entries[1]],
  }));
  assert.deepEqual(authorizedTransferIndexes({
    ...batch,
    entries: [{ ...batch.entries[0], status: "submitted" }, batch.entries[1]],
  }), [1]);
});

test("暫停批次只續跑送出前失敗與未開始的個體", () => {
  const batch = {
    status: "paused",
    mode: "bulk",
    error: "搜尋欄未確認",
    entries: [
      { pokemonId: "done", status: "submitted", reason: null },
      { pokemonId: "retry", status: "skipped", reason: "搜尋欄未確認" },
      { pokemonId: "untouched", status: "pending", reason: null },
      { pokemonId: "protected", status: "skipped", reason: "特殊背卡" },
    ],
  } as TransferBatch;
  assert.deepEqual(resumableTransferIndexes(batch), [1, 2]);
  assert.deepEqual(resumableTransferIndexes({
    ...batch,
    entries: batch.entries.map((entry, index) =>
      index === 1 ? { ...entry, preparedAt: "2026-10-26T00:00:00Z" } : entry,
    ),
  }), [2]);
  assert.deepEqual(resumableTransferIndexes({
    ...batch,
    mode: "single",
    error: "不是一般放生確認畫面，或出現額外警告；尚未放生",
    entries: batch.entries.map((entry, index) => index === 1
      ? {
          ...entry,
          reason: "不是一般放生確認畫面，或出現額外警告；尚未放生",
          preparedAt: "2026-10-26T00:00:00Z",
          evidence: "search-cp.jpg",
        }
      : entry),
  }), [1]);
  assert.deepEqual(resumableTransferIndexes({
    ...batch,
    entries: [...batch.entries, { pokemonId: "unknown", status: "uncertain", reason: null }],
  }), []);
  assert.deepEqual(resumableTransferIndexes({ ...batch, status: "approved" }), []);
});

test("前景 App 短暫切換只重新觀察；持續離開遊戲則暫停", async () => {
  const frame = (app: string) => ({
    app,
    observation_id: app,
    image: { path: "/tmp/mock.png", width: 100, height: 200, pixel_to_point: [1, 1] },
  });
  let observations = 0;
  const phone = {
    async call() {
      observations++;
      return frame("com.nianticlabs.pokemongo");
    },
  } as unknown as IphoneMcp;
  const first = frame("com.apple.springboard") as Awaited<ReturnType<typeof observeGameForeground>>;
  const waits: number[] = [];
  assert.equal((await observeGameForeground(phone, first, async (ms) => { waits.push(ms); })).app, "com.nianticlabs.pokemongo");
  assert.equal(observations, 1);
  assert.deepEqual(waits, [1500]);
  const away = { async call() { return frame("com.apple.springboard"); } } as unknown as IphoneMcp;
  await assert.rejects(() => observeGameForeground(away, first, async () => {}), /不是前景 App/);
});

test("放生已送出後遇通知，只重試未執行的返回列表點擊", async () => {
  const frame = (app: string, id: string) => ({
    app, observation_id: id,
    image: { path: "/tmp/mock.png", width: 100, height: 200, pixel_to_point: [1, 1] },
    viewport: { width: 100, height: 200 },
  });
  const screenshots = [
    frame("com.apple.springboard", "notification"),
    frame("com.nianticlabs.pokemongo", "fresh"),
    frame("com.nianticlabs.pokemongo", "returned"),
  ];
  const taps: Record<string, unknown>[] = [];
  const waits: number[] = [];
  const phone = {
    async call(name: string, args: Record<string, unknown>) {
      if (name === "observe") return screenshots.shift();
      if (name === "tap") {
        taps.push(args);
        if (taps.length === 1)
          throw Object.assign(new Error("The foreground app changed"), {
            code: "stale_observation", uncertain: false,
          });
        return { action_executed: true };
      }
      throw new Error(`Unexpected phone call: ${name}`);
    },
  } as unknown as IphoneMcp;
  const result = await settleAfterSubmitted(
    phone, frame("com.nianticlabs.pokemongo", "old"), false,
    async (ms) => { waits.push(ms); },
  );
  assert.equal(result.observation_id, "returned");
  assert.deepEqual(waits, [700, 1500]);
  assert.deepEqual(taps.map((tap) => tap.observation_id), ["old", "fresh"]);
  assert.ok(taps.every((tap) => tap.x === 9.5 && tap.y === 35.4));
});

test("放生後返回列表的點擊結果不明時不自動重試", async () => {
  let taps = 0;
  const phone = {
    async call(name: string) {
      if (name === "tap") {
        taps++;
        throw Object.assign(new Error("回應不明"), {
          code: "action_uncertain", uncertain: true,
        });
      }
      throw new Error(`Unexpected phone call: ${name}`);
    },
  } as unknown as IphoneMcp;
  const dialog = {
    app: "com.nianticlabs.pokemongo", observation_id: "old",
    image: { path: "/tmp/mock.png", width: 100, height: 200, pixel_to_point: [1, 1] },
  } as Awaited<ReturnType<typeof observeGameForeground>>;
  await assert.rejects(() => settleAfterSubmitted(phone, dialog, false, async () => {}), /回應不明/);
  assert.equal(taps, 1);
});

test("連續同圖鑑編號只保留同一搜尋結果，換物種或最後一隻返回盒子", () => {
  const snapshot = fixture();
  snapshot.species.weak.dex = 11;
  const analysis = { category: "transfer", currentLevels: [15] } as ReturnType<typeof record>["analysis"];
  const first = record("same-dex-first", { favorite: false }, { analysis });
  const second = record("same-dex-second", { favorite: false }, { analysis });
  const batch = {
    mode: "bulk",
    entries: [first, second].map((pokemon) => ({
      pokemonId: pokemon.id, status: "pending", reason: null,
    })),
  } as TransferBatch;
  assert.equal(nextPendingUsesDex(batch, 0, 10, [first, second], snapshot), true);
  assert.equal(nextPendingUsesDex(batch, 1, 10, [first, second], snapshot), false);
  assert.equal(nextPendingUsesDex({ ...batch, mode: "single" }, 0, 10, [first, second], snapshot), false);
  assert.equal(nextPendingUsesDex(batch, 0, 10, [first, { ...second, locked: true }], snapshot), false);
  const different = record(second.id, { favorite: false, speciesId: "weak" }, { analysis });
  assert.equal(nextPendingUsesDex(batch, 0, 10, [first, different], snapshot), false);
});

test("本機 OCR 只接受一般放生確認，額外警告不得點確認", () => {
  const line = (text: string, y: number) => ({ text, y, x: 0.4, confidence: 1 });
  const ordinary = [
    line("確定要將 肯泰羅 傳送給博士？", 0.593),
    line("傳送後將無法取消", 0.535),
    line("YES", 0.456),
    line("NO", 0.379),
  ];
  assert.equal(standardTransferDialog(ordinary), true);
  assert.equal(standardTransferDialog([
    ...ordinary.slice(0, 3),
    { ...ordinary[3], text: "ZO", x: 0.46 },
  ]), true);
  assert.equal(standardTransferDialog([
    ...ordinary.slice(0, 3),
    { ...ordinary[3], text: "ZO", x: 0.2 },
  ]), false);
  assert.equal(standardTransferDialog([
    ...ordinary.slice(0, 3),
    { ...ordinary[3], text: "ZO", x: 0.46 },
    line("額外放生警告", 0.41),
  ]), false);
  assert.equal(standardTransferDialog([
    line("確定要將 火紅不倒翁", 0.613),
    line("傳送給博士？", 0.576),
    line("傳送後將無法取消", 0.517),
    line("YES", 0.439),
    line("NO", 0.360),
  ]), true);
  assert.equal(standardTransferDialog([...ordinary, line("其他警告", 0.5)]), false);
  assert.equal(standardTransferDialog([...ordinary, line("傳送特殊寶可夢？", 0.49)]), false);
  assert.equal(standardTransferDialog(ordinary.slice(0, 3)), false);
});

test("列表起點只用本機 OCR 確認寶可夢盒與圖鑑搜尋值", () => {
  const line = (text: string, x: number, y: number) => ({
    text, x, y, confidence: 1,
  });
  const title = line("寶可夢", 0.44, 0.905);
  assert.equal(collectionSearchState([title, line("Q搜尋", 0.43, 0.812)]), "empty");
  assert.equal(collectionSearchState([title, line("656/725", 0.44, 0.89)]), "empty");
  assert.equal(collectionSearchState([title]), null);
  const active = [title, line("Q 928", 0.18, 0.812)];
  assert.equal(collectionSearchState(active), "active");
  assert.equal(collectionSearchState([title, line("Q background", 0.18, 0.812)]), "active");
  assert.equal(collectionSearchState([title, line("Q 背卡", 0.18, 0.812)]), "active");
  assert.equal(searchQueryMatches(active, 928), true);
  assert.equal(searchQueryMatches(active, 929), false);
  assert.equal(searchQueryMatches([title, line("9 919", 0.18, 0.812)], 919), true);
  assert.equal(searchQueryMatches([title, line("9 1919", 0.18, 0.812)], 919), false);
  assert.equal(backgroundQueryMatches([title, line("Q 928&背卡", 0.18, 0.812)], 928), true);
  assert.equal(backgroundQueryMatches([title, line("Q 928", 0.18, 0.812)], 928), false);
  assert.equal(backgroundQueryMatches([title, line("Q 928&background", 0.18, 0.812)], 928), false);
  assert.equal(backgroundQueryMatches([title, line("Q 929&背卡", 0.18, 0.812)], 928), false);
  assert.equal(searchQueryMatches([title, line("Q 928&背卡", 0.18, 0.812)], 928), false);
  assert.equal(nonBackgroundQuery(928), "928&!背卡");
  assert.equal(nonBackgroundQueryMatches([title, line("Q 928&!背卡", 0.18, 0.812)], 928), true);
  assert.equal(nonBackgroundQueryMatches([title, line("Q 928!背卡", 0.18, 0.812)], 928), false);
  assert.equal(nonBackgroundQueryMatches([title, line("Q 928&背卡", 0.18, 0.812)], 928), false);
  assert.equal(nonBackgroundQueryMatches([title, line("Q 929&!背卡", 0.18, 0.812)], 928), false);
  assert.equal(croppedNonBackgroundQueryMatches([line("870&！背卡", 0.2, 0.5)], 870), true);
  assert.equal(croppedNonBackgroundQueryMatches([line("870&背卡", 0.2, 0.5)], 870), false);
  assert.equal(croppedNonBackgroundQueryMatches([line("871&！背卡", 0.2, 0.5)], 870), false);
  const negative = [line("870&！背卡", 0.2, 0.5)];
  const missedMark = [line("870&背卡", 0.2, 0.5)];
  assert.equal(croppedNonBackgroundConsensus([negative, missedMark, negative], 870), true);
  assert.equal(croppedNonBackgroundConsensus([negative, missedMark, missedMark], 870), false);
  assert.equal(croppedNonBackgroundConsensus([missedMark, missedMark, missedMark], 870), false);
  assert.equal(croppedBackgroundTextCompatible([[line("333&.背卡", 0.2, 0.5)]], 333), true);
  assert.equal(croppedBackgroundTextCompatible([[line("334&.背卡", 0.2, 0.5)]], 333), false);
  assert.equal(hasExclamationRun([
    { start: 232, end: 248, minY: 11, maxY: 30 },
    { start: 253, end: 256, minY: 11, maxY: 30 },
    { start: 261, end: 283, minY: 8, maxY: 32 },
    { start: 288, end: 311, minY: 8, maxY: 32 },
  ], 719, 1536), true);
  assert.equal(hasExclamationRun([
    { start: 232, end: 248, minY: 11, maxY: 30 },
    { start: 254, end: 276, minY: 8, maxY: 32 },
    { start: 281, end: 303, minY: 8, maxY: 32 },
  ], 719, 1536), false);
  const background = [title, line("Q 928&背卡", 0.18, 0.812),
    line("寶可夢 (1)", 0.44, 0.905), line("CP 100", 0.2, 0.7)];
  assert.equal(backgroundSearchDecision(background, 928, 100), "protected");
  assert.equal(backgroundSearchDecision(background, 928, 101), "clear");
  assert.equal(backgroundSearchDecision(background.slice(0, -1), 928, 101), "unknown");
  assert.equal(backgroundSearchDecision([title, line("Q 928&背卡", 0.18, 0.812),
    line("寶可夢 (0)", 0.44, 0.905)], 928, 101), "clear");
  assert.equal(collectionSearchState([line("寶可夢", 0.44, 0.2)]), null);
});

test("編號搜尋只接受完整盒子中唯一相同 CP，OCR 依列表欄位定位", () => {
  const snapshot = fixture();
  const target = record("cp-target");
  const peer = record("cp-peer", { cp: 180 });
  assert.deepEqual(
    assertUniqueDexCp(target, [target, peer], snapshot, new Set([target.id, peer.id])),
    { dex: 10, cp: 179 },
  );
  assert.throws(() =>
    assertUniqueDexCp(target, [target, peer], snapshot, null),
  );
  assert.throws(() =>
    assertUniqueDexCp(
      target,
      [target, { ...peer, fields: { ...peer.fields, cp: 179 } }],
      snapshot,
      new Set([target.id, peer.id]),
    ),
  );
  assert.deepEqual(
    cpCandidates([
      { text: "CP 179", confidence: 0.9, x: 0.43, y: 0.6 },
      { text: "CP", confidence: 0.9, x: 0.7, y: 0.4 },
      { text: "180", confidence: 0.9, x: 0.76, y: 0.4 },
      { text: "CP 999", confidence: 0.9, x: 0.43, y: 0.93 },
    ]),
    [
      { cp: 179, x: 0.5, y: 0.49 },
      { cp: 180, x: 0.83, y: 0.69 },
    ],
  );
  assert.equal(
    searchResultCount([
      { text: "Q（2）", confidence: 0.3, x: 0.44, y: 0.88 },
    ]),
    2,
  );
  assert.equal(
    detailCp([{ text: "CP 179", confidence: 0.9, x: 0.4, y: 0.86 }]),
    179,
  );
  assert.equal(
    detailCp([
      { text: "CP 179", confidence: 0.9, x: 0.4, y: 0.86 },
      { text: "CP 180", confidence: 0.9, x: 0.4, y: 0.85 },
    ]),
    null,
  );
});

test("只有 Game Master 所有形態都明確無性別時才補上無性別", () => {
  const gender = (dex: number, form: string, ratio: Record<string, number>) => ({
    templateId: `SPAWN_V${String(dex).padStart(4, "0")}_POKEMON_${form}`,
    data: { genderSettings: { gender: ratio } },
  });
  const genderless = genderlessByDex([
    gender(81, "MAGNEMITE", { genderlessPercent: 1 }),
    gender(81, "MAGNEMITE_NORMAL", { genderlessPercent: 1 }),
    gender(25, "PIKACHU", { malePercent: 0.5, femalePercent: 0.5 }),
    gender(26, "RAICHU", { genderlessPercent: 1 }),
    gender(26, "RAICHU_ALOLA", { malePercent: 0.5, femalePercent: 0.5 }),
  ]);
  assert.equal(genderless.has(81), true);
  assert.equal(genderless.has(25), false);
  assert.equal(genderless.has(26), false);
  const species = { ...fixture().species.caterpie, genderless: true };
  assert.deepEqual(safety.speciesGender(null, species), {
    gender: "genderless",
    conflict: false,
  });
  assert.deepEqual(safety.speciesGender("male", species), {
    gender: "male",
    conflict: true,
  });
  assert.equal(
    safety.speciesGender(null, fixture().species.caterpie).gender,
    null,
  );
});

test("遷怒與報恩只提供暗影或淨化的正面證據；衝突仍需核對", () => {
  const unknown = record("move-state", {
    shadow: null,
    purified: null,
    chargeMove: null,
    chargeMove2: null,
  }).fields;
  assert.deepEqual(safety.specialStateFromMoves(unknown), {
    shadow: null,
    purified: null,
    signal: null,
    conflict: false,
  });
  assert.deepEqual(
    safety.specialStateFromMoves({ ...unknown, chargeMove: "遷怒" }),
    { shadow: true, purified: false, signal: "frustration", conflict: false },
  );
  assert.deepEqual(
    safety.specialStateFromMoves({ ...unknown, chargeMove2: "RETURN" }),
    { shadow: false, purified: true, signal: "return", conflict: false },
  );
  assert.equal(
    safety.specialStateFromMoves({
      ...unknown,
      shadow: true,
      chargeMove: "報恩",
    }).conflict,
    true,
  );
});

test("色違雙畫面複核只接受一致且明確對照一般配色的結果", () => {
  const normal = {
    verdict: "normal" as const,
    referenceDistinct: true,
    sparklesVisible: false,
    iconAreaClear: false,
    shinyIconVisible: false,
    normalColorMatch: true,
    shinyColorMatch: false,
    reason: "兩張畫面與一般配色一致",
  };
  assert.equal(shinyConsensus(normal, normal), "normal");
  assert.equal(
    shinyConsensus(normal, { ...normal, sparklesVisible: true }),
    "uncertain",
  );
  assert.equal(
    shinyConsensus(normal, { ...normal, referenceDistinct: false }),
    "uncertain",
  );
  assert.equal(
    shinyConsensus(normal, { ...normal, verdict: "shiny" }),
    "uncertain",
  );
  const subtle = { ...normal, referenceDistinct: false, iconAreaClear: true };
  assert.equal(shinyConsensus(subtle, subtle), "normal");
  assert.equal(
    shinyConsensus(subtle, { ...subtle, shinyIconVisible: true }),
    "uncertain",
  );
});

test("捕獲日期只從右側同一徽章的兩行本機 OCR 讀取", () => {
  const year = { text: "2021", confidence: 1, x: 0.87, y: 0.63 };
  const monthDay = { text: "09/03", confidence: 0.5, x: 0.87, y: 0.6 };
  assert.equal(caughtDateBadge([year, monthDay]), "2021-09-03");
  assert.equal(caughtDateBadge([year, { ...monthDay, x: 0.4 }]), null);
  assert.equal(caughtDateBadge([year, { ...monthDay, y: 0.4 }]), null);
  assert.equal(caughtDateBadge([year, year, monthDay]), null);
});

test("本機 OCR 傳出文字前移除日期與招式頁底部地點", () => {
  const lines = [
    { text: "CP661", confidence: 1, x: 0.35, y: 0.96 },
    { text: "2021", confidence: 1, x: 0.87, y: 0.63 },
    { text: "02/21", confidence: 1, x: 0.87, y: 0.6 },
    { text: "在地圖上捉到", confidence: 1, x: 0.2, y: 0.01 },
  ];
  assert.match(formatOcrLines(lines, "top"), /CP661/);
  assert.doesNotMatch(formatOcrLines(lines, "top"), /2021|02\/21/);
  assert.doesNotMatch(formatOcrLines(lines, "moves"), /在地圖上捉到/);
});

test("離線辨識至多三隻並行，仍依掃描順序寫入", async () => {
  const applied: number[] = [];
  let running = 0;
  let peak = 0;
  const finished = await processPreparedInOrder({
    items: [0, 1, 2, 3, 4],
    needsPreparation: () => true,
    active: () => true,
    prepare: async (item) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 25 : 2));
      running--;
      return item;
    },
    consume: async (_item, result) => {
      applied.push(result);
    },
    concurrency: 3,
  });
  assert.equal(finished, true);
  assert.deepEqual(applied, [0, 1, 2, 3, 4]);
  assert.equal(peak, 3);
});

test("離線辨識暫停後取消尚未寫入的預先請求", async () => {
  let active = true;
  let aborted = 0;
  const applied: number[] = [];
  const finished = await processPreparedInOrder({
    items: [0, 1, 2],
    needsPreparation: () => true,
    active: () => active,
    prepare: (item, signal) =>
      item === 0
        ? Promise.resolve(item)
        : new Promise<number>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted++;
              reject(new Error("已取消"));
            }, { once: true });
          }),
    consume: async (_item, result) => {
      applied.push(result);
      active = false;
    },
  });
  assert.equal(finished, false);
  assert.deepEqual(applied, [0]);
  assert.equal(aborted, 2);
});

test("翻頁進展只比較靜態身分區，忽略寶可夢動畫", async () => {
  const make = async (name: string, sprite: string, cp: string) => {
    const file = path.join(temp, `${name}.png`);
    const overlay = Buffer.from(
      `<svg width="600" height="1128"><rect x="220" y="8" width="${cp}" height="20" fill="black"/><rect x="220" y="460" width="130" height="22" fill="black"/><rect x="${sprite}" y="230" width="50" height="50" fill="black"/></svg>`,
    );
    await sharp({
      create: { width: 600, height: 1128, channels: 3, background: "white" },
    })
      .composite([{ input: overlay }])
      .png()
      .toFile(file);
    return detailFingerprint(file);
  };
  const first = await make("first", "100", "40");
  assert.equal(first, await make("animated", "390", "40"));
  assert.notEqual(first, await make("next", "100", "100"));
});

test("已完成截圖的解析可離線續跑，缺少截圖檢查點不得完成", async () => {
  const stamp = new Date().toISOString();
  const base: Scan = {
    id: "offline-analysis",
    scope: "results",
    status: "queued",
    stage: "準備解析",
    createdAt: stamp,
    updatedAt: stamp,
    scanned: 0,
    phase: "analysis",
    analyzed: 0,
    review: 0,
    expected: 0,
    sort: null,
    currentFrame: null,
    lastFingerprint: null,
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null,
    checkpointRequired: false,
    iphoneUseVersion: null,
  };
  store.put("scans", base.id, base);
  const disconnected = {
    async call() {
      throw new Error("解析期間不應操作手機");
    },
  } as unknown as IphoneMcp;
  await runScan(disconnected, base);
  assert.equal(store.get<Scan>("scans", base.id)?.status, "completed");
  store.put("scans", base.id, {
    ...base,
    status: "running",
    scanned: 1,
    expected: 1,
  });
  await assert.rejects(() => analyzeScan(base.id), /檢查點不完整|數量與盒子總數不符/);
});

test("逐隻截圖只使用固定導航與本機 IV 量測，不呼叫頁面辨識", async () => {
  const stamp = new Date().toISOString();
  const scanId = "fast-capture-test";
  const plain = path.join(temp, "plain-screen.png");
  const bars = path.join(temp, "appraisal-screen.png");
  await sharp({
    create: { width: 600, height: 1304, channels: 3, background: "white" },
  })
    .png()
    .toFile(plain);
  const ivBars = [920, 980, 1040]
    .map(
      (y) =>
        `<rect x="72" y="${y}" width="207" height="8" rx="4" fill="#dddde0"/><rect x="72" y="${y}" width="193" height="8" rx="4" fill="#f1a348"/>`,
    )
    .join("");
  await sharp(
    Buffer.from(
      `<svg width="600" height="1304"><rect width="600" height="1304" fill="white"/>${ivBars}</svg>`,
    ),
  )
    .png()
    .toFile(bars);
  const screen = (file: string, id: string) => ({
    app: "com.nianticlabs.pokemongo",
    observation_id: id,
    image: {
      path: file,
      width: 600,
      height: 1304,
      pixel_to_point: [0.5, 0.5],
    },
    viewport: { width: 300, height: 652 },
  });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let taps = 0;
  let observes = 0;
  const phone = {
    async call(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "swipe") return { observation: screen(plain, "moves") };
      if (name === "tap") {
        taps++;
        return {
          observation: screen(taps === 2 ? bars : plain, `tap-${taps}`),
        };
      }
      if (name === "observe") {
        observes++;
        return screen(observes === 1 ? bars : plain, `observe-${observes}`);
      }
      throw new Error(`不應呼叫 ${name}`);
    },
  } as unknown as IphoneMcp;
  store.put("scans", scanId, {
    id: scanId,
    scope: "results",
    status: "running",
    phase: "capture",
    analyzed: 0,
    stage: "截圖中",
    createdAt: stamp,
    updatedAt: stamp,
    scanned: 0,
    review: 0,
    expected: 1,
    sort: null,
    currentFrame: null,
    lastFingerprint: null,
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null,
    checkpointRequired: false,
    iphoneUseVersion: null,
  });
  await captureOne(phone, store.get<Scan>("scans", scanId)!, screen(plain, "top"));
  assert.equal(store.get<Scan>("scans", scanId)?.scanned, 1);
  assert.equal(store.get<Scan>("scans", scanId)?.apiUsage.requests, 0);
  assert.equal(
    store.all<{ scanId: string }>("scan_items").filter((item) => item.scanId === scanId).length,
    1,
  );
  assert.equal(
    store.listPokemon().filter((pokemon) => pokemon.jobId === scanId).length,
    0,
  );
  assert.deepEqual(calls.map((call) => call.name), [
    "swipe", "tap", "tap", "observe", "tap",
  ]);
  assert.equal(calls[1].args.observe, "screenshot");
});

test("備份包含尚未解析的三張手機截圖", async () => {
  const scanId = "raw-capture-backup";
  const dir = path.join(temp, "frames", scanId);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["top", "moves", "iv"])
    fs.writeFileSync(path.join(dir, `${name}.jpg`), Buffer.from(`test-${name}`));
  store.put("scan_items", "raw-item", {
    id: "raw-item",
    scanId,
    position: 0,
    frame: `${scanId}/top.jpg`,
    movesFrame: `${scanId}/moves.jpg`,
    appraisalFrame: `${scanId}/iv.jpg`,
    measuredIV: [14, 12, 13],
    fingerprint: "static",
    pokemonId: null,
    fields: null,
    issues: [],
    protectionClear: false,
    shinyReview: {
      verdict: "normal",
      model: "test-model",
      reason: "兩張已存畫面與一般參考圖一致",
      referenceHashes: ["a".repeat(64), "b".repeat(64)],
      reviewedAt: new Date().toISOString(),
    },
    capturedAt: new Date().toISOString(),
  });
  const backup = await exportBackup();
  assert.ok(backup.frames?.[`${scanId}/top.jpg`]);
  assert.ok(backup.frames?.[`${scanId}/moves.jpg`]);
  assert.ok(backup.frames?.[`${scanId}/iv.jpg`]);
  store.remove("scan_items", "raw-item");
  await importBackup(backup);
  assert.equal(
    store.get<ScanItem>("scan_items", "raw-item")?.shinyReview?.verdict,
    "normal",
  );
  store.remove("scan_items", "raw-item");
});

test("舊版進行中的掃描保留已辨識項目並轉為截圖階段", () => {
  const stamp = new Date().toISOString();
  const scanId = "legacy-running-scan";
  const scan: Scan = {
    id: scanId,
    scope: "all",
    status: "running",
    stage: "掃描中",
    createdAt: stamp,
    updatedAt: stamp,
    scanned: 1,
    review: 1,
    expected: 725,
    sort: null,
    currentFrame: null,
    lastFingerprint: null,
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null,
    checkpointRequired: false,
    iphoneUseVersion: null,
  };
  store.put("scans", scanId, scan);
  store.put("scan_items", "legacy-item", {
    id: "legacy-item",
    scanId,
    position: 0,
    frame: `${scanId}/top.jpg`,
    appraisalFrame: `${scanId}/iv.jpg`,
    fingerprint: "old",
    pokemonId: "existing-pokemon",
    fields: record("legacy").fields,
    issues: [],
    protectionClear: false,
    capturedAt: stamp,
  });
  recoverInterruptedPhoneWork();
  const recovered = store.get<Scan>("scans", scanId)!;
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.phase, "capture");
  assert.equal(recovered.scanned, 1);
  assert.equal(recovered.analyzed, 1);
});

test("自動核對需要穩定 IV 量測、身分與特殊狀態明確", () => {
  const fields = record("iv", { favorite: false }).fields;
  const input = {
    fields,
    top: fields,
    appraisal: fields,
    measuredIV: [14, 12, 13],
    levels: [15],
    clear: true,
    issues: [] as string[],
    costumeAbsentClear: true,
    warningVisible: false,
  };
  assert.equal(safety.automaticVerification(input), true);
  assert.equal(
    safety.automaticVerification({
      ...input,
      fields: { ...fields, favorite: true },
    }),
    true,
  );
  assert.equal(
    safety.automaticVerification({
      ...input,
      appraisal: { ...fields, ivAtk: null },
    }),
    false,
  );
  assert.equal(
    safety.automaticVerification({ ...input, measuredIV: [13, 12, 13] }),
    false,
  );
  assert.equal(
    safety.automaticVerification({
      ...input,
      fields: { ...fields, favorite: null },
    }),
    false,
  );
  assert.equal(
    safety.automaticVerification({ ...input, issues: ["畫面衝突"] }),
    false,
  );
  assert.equal(
    safety.automaticVerification({ ...input, warningVisible: true }),
    false,
  );
});

test("評價頁遮擋資源的註記不阻擋核對，IV 衝突仍阻擋", () => {
  const fields = record("resource-evidence", {
    stardust: 1798059,
    candy: 255,
    xlCandy: 4,
    powerUpDust: 2200,
    powerUpCandy: 2,
  }).fields;
  assert.deepEqual(
    safety.blockingEvidenceIssues([
      "隊長評價介面遮擋部分資源數字及按鈕資訊，無法完整讀取。",
      "隊長評價介面遮擋部分資源數字與強化成本；無法完整辨識的欄位填 null。",
      "畫面上方未顯示名稱、CP及寶可夢完整外觀，無法確認形態與外觀特徵。",
      "隊長與評價介面遮住部分身高及資源數字，無法完整辨讀。",
      "ivAtk：AI 13 與評價條量測 14 不一致",
    ], fields),
    [
      "隊長與評價介面遮住部分身高及資源數字，無法完整辨讀。",
      "ivAtk：AI 13 與評價條量測 14 不一致",
    ],
  );
  assert.deepEqual(
    safety.blockingEvidenceIssues(
      ["評價介面遮住部分資源數字與強化資訊，無法完整讀取。"],
      { ...fields, stardust: null },
    ),
    ["評價介面遮住部分資源數字與強化資訊，無法完整讀取。"],
  );
});

test("下半部截圖的缺口由能力頁和評價頁交叉確認", () => {
  const fields = record("charmander").fields;
  const note = "畫面僅顯示詳情頁下半部，名稱、CP、HP及寶可夢外觀未顯示，無法確認物種與外觀特徵。";
  const ambiguity = "物種／形態無法唯一對應，請選擇正確物種";
  const input = {
    issues: [note, ambiguity, "多個畫面欄位衝突：costume"],
    fields,
    top: fields,
    appraisal: fields,
    speciesName: fields.name,
    detailClear: true,
    costumeAbsentClear: true,
  };
  assert.deepEqual(safety.reconcilePageIssues(input), ["多個畫面欄位衝突：costume"]);
  assert.deepEqual(
    safety.reconcilePageIssues({ ...input, appraisal: { ...fields, cp: fields.cp! + 1 } }),
    input.issues,
  );
  assert.deepEqual(
    safety.reconcilePageIssues({ ...input, costumeAbsentClear: false }),
    [ambiguity, "多個畫面欄位衝突：costume"],
  );
});

test("CP、HP、IV 只對應唯一同圖鑑形態時修正形態", () => {
  const snapshot = fixture();
  snapshot.species.caterpie = {
    ...snapshot.species.caterpie,
    id: "caterpie_incarnate",
    form: "(Incarnate)",
  };
  snapshot.species.caterpie_therian = {
    ...snapshot.species.caterpie,
    id: "caterpie_therian",
    atk: 95,
    form: "(Therian)",
  };
  const therian = snapshot.species.caterpie_therian;
  const fields = record("form", {
    speciesId: "caterpie",
    ivAtk: 14,
    ivDef: 13,
    ivSta: 11,
    cp: combatPower(therian, [14, 13, 11], 20, snapshot),
    hp: hitPoints(therian, 11, 20, snapshot),
  }).fields;
  assert.deepEqual(uniqueFormFromStats(fields, snapshot), {
    species: therian,
    level: 20,
  });
  assert.equal(displayForm(therian), "靈獸形態");
  assert.equal(uniqueFormFromStats({ ...fields, hp: null }, snapshot), null);
  snapshot.species.caterpie_duplicate = {
    ...therian,
    id: "caterpie_duplicate",
  };
  assert.equal(uniqueFormFromStats(fields, snapshot), null);
});

test("圖鑑編號直接輸入一次，確認後才送出搜尋", async () => {
  const typed: string[] = [];
  const submitted: [number, boolean][] = [];
  const phone = {} as IphoneMcp;
  await typeNumericSearch(phone, 125, async (query) => { typed.push(query); }, async () => {}, async (_phone, dex, background) => { submitted.push([dex, background]); });
  assert.deepEqual(typed, ["125"]);
  assert.deepEqual(submitted, [[125, false]]);
  await assert.rejects(() => typeNumericSearch(phone, 0, async () => {}), /圖鑑編號/);
});

test("繁中背卡查詢直接輸入；注入失敗時不送出搜尋", async () => {
  const typed: string[] = [];
  const submitted: [number, boolean][] = [];
  const phone = {} as IphoneMcp;
  await typeBackgroundSearch(phone, 656, async (query) => { typed.push(query); }, async () => {}, async (_phone, dex, background) => { submitted.push([dex, background]); });
  assert.deepEqual(typed, ["656&背卡"]);
  assert.deepEqual(submitted, [[656, true]]);
  await assert.rejects(
    () => typeBackgroundSearch(phone, 656, async () => { throw new Error("WDA 輸入不明"); }, async () => {}, async () => { submitted.push([0, false]); }),
    /WDA 輸入不明/,
  );
  assert.deepEqual(submitted, [[656, true]]);
});

test("排除背卡搜尋只輸入一次，並以完整查詢核對後才送出", async () => {
  const typed: string[] = [];
  const submitted: [number, boolean | "exclude-background"][] = [];
  const phone = {} as IphoneMcp;
  await typeNonBackgroundSearch(phone, 656,
    async (query) => { typed.push(query); }, async () => {},
    async (_phone, dex, mode) => { submitted.push([dex, mode]); });
  assert.deepEqual(typed, ["656&!背卡"]);
  assert.deepEqual(submitted, [[656, "exclude-background"]]);
  await assert.rejects(
    () => typeNonBackgroundSearch(phone, 656,
      async () => { throw new Error("輸入失敗"); }, async () => {},
      async () => { submitted.push([0, false]); }),
    /輸入失敗/,
  );
  assert.deepEqual(submitted, [[656, "exclude-background"]]);
});

test("已知最愛可列入確認批次，未知最愛及其他特殊狀態仍排除", () => {
  const snapshot = fixture();
  const base = evaluateCollection(
    [record("base", { favorite: false })],
    snapshot,
    settings,
  )[0];
  assert.equal(base.analysis?.category, "transfer");
  assert.equal(safety.transferExclusion(base, snapshot), null);
  assert.equal(
    safety.transferExclusion(
      { ...base, fields: { ...base.fields, favorite: true } },
      snapshot,
    ),
    null,
  );
  assert.ok(
    safety.transferExclusion(
      { ...base, fields: { ...base.fields, favorite: null } },
      snapshot,
    ),
  );
  assert.ok(
    safety.transferExclusion(
      { ...base, fields: { ...base.fields, shiny: true } },
      snapshot,
    ),
  );
  assert.ok(
    safety.transferExclusion(
      { ...base, fields: { ...base.fields, shadow: true, chargeMove: "RETURN" } },
      snapshot,
    ),
  );
  assert.ok(
    safety.transferExclusion(
      { ...base, fields: { ...base.fields, hp: null } },
      snapshot,
    ),
  );
  assert.ok(safety.transferExclusion({ ...base, locked: true }, snapshot));
  snapshot.species.caterpie.tags.push("legendary");
  assert.ok(safety.transferExclusion(base, snapshot));
});

test("放生確認的簽章會偵測收藏或設定改變", () => {
  const p = evaluateCollection(
    [record("candidate", { favorite: false })],
    fixture(),
    settings,
  )[0];
  const batch = {
    scanId: "scan",
    entries: [{ pokemonId: p.id, status: "pending" as const, reason: null }],
  };
  const signature = safety.transferSignature(batch, [p], fixture(), settings);
  assert.notEqual(
    signature,
    safety.transferSignature(
      batch,
      [{ ...p, locked: true }],
      fixture(),
      settings,
    ),
  );
  assert.notEqual(
    signature,
    safety.transferSignature(batch, [p], fixture(), {
      ...settings,
      raidSlots: settings.raidSlots - 1,
    }),
  );
});

test("v2 備份保存手機歷史，但還原後沒有放生授權", async () => {
  const stamp = new Date().toISOString();
  const scan: Scan = {
    id: "scan",
    scope: "results",
    status: "completed",
    stage: "完成",
    createdAt: stamp,
    updatedAt: stamp,
    scanned: 1,
    review: 0,
    expected: 1,
    sort: "CP",
    currentFrame: null,
    lastFingerprint: null,
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0 },
    error: null,
    checkpointRequired: false,
    iphoneUseVersion: "0.3.16",
  };
  const batch: TransferBatch = {
    id: "batch",
    scanId: scan.id,
    createdAt: stamp,
    updatedAt: stamp,
    status: "running",
    mode: "single",
    selectedPokemonId: "candidate",
    signature: "test",
    entries: [
      { pokemonId: "candidate", status: "sent", reason: null },
      { pokemonId: "already-tapped", status: "submitted", reason: "未核對遊戲結果", submittedAt: stamp },
    ],
    error: null,
    approvedAt: stamp,
  };
  store.put("scans", scan.id, scan);
  store.put("transfer_batches", batch.id, batch);
  const evolution = record("backup-evolution", {}, { evolutionSilhouette: true });
  store.put("pokemon", evolution.id, evolution);
  const backup = await exportBackup();
  assert.equal(backup.version, 2);
  store.remove("scans", scan.id);
  store.remove("transfer_batches", batch.id);
  store.remove("pokemon", evolution.id);
  await importBackup(backup);
  assert.equal(store.get<Scan>("scans", scan.id)?.status, "completed");
  assert.equal(
    store.get<TransferBatch>("transfer_batches", batch.id)?.status,
    "stopped",
  );
  assert.equal(
    store.get<TransferBatch>("transfer_batches", batch.id)?.entries[0].status,
    "uncertain",
  );
  assert.equal(
    store.get<TransferBatch>("transfer_batches", batch.id)?.entries[1].status,
    "submitted",
  );
  assert.equal(
    store.get<TransferBatch>("transfer_batches", batch.id)?.approvedAt,
    null,
  );
  assert.equal(
    store.get<TransferBatch>("transfer_batches", batch.id)?.selectedPokemonId,
    null,
  );
  assert.equal(
    store.get<import("../src/lib/types").Pokemon>("pokemon", evolution.id)
      ?.evolutionSilhouette,
    true,
  );
  store.remove("pokemon", evolution.id);
});

test("背景服務重啟不重送可能已執行的放生", () => {
  const stamp = new Date().toISOString();
  const batch: TransferBatch = {
    id: "interrupted",
    scanId: "scan",
    createdAt: stamp,
    updatedAt: stamp,
    status: "running",
    signature: "test",
    entries: [
      { pokemonId: "a", status: "sent", reason: null },
      { pokemonId: "b", status: "pending", reason: null },
      { pokemonId: "c", status: "unfavoriting", reason: null },
    ],
    error: null,
    approvedAt: stamp,
  };
  store.put("transfer_batches", batch.id, batch);
  recoverInterruptedPhoneWork();
  const recovered = store.get<TransferBatch>("transfer_batches", batch.id)!;
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.entries[0].status, "uncertain");
  assert.equal(recovered.entries[1].status, "pending");
  assert.equal(recovered.entries[2].status, "uncertain");
  assert.match(recovered.entries[2].reason || "", /尚未送出放生/);
  recoverInterruptedPhoneWork();
  assert.equal(
    store.get<TransferBatch>("transfer_batches", batch.id)?.entries[0].status,
    "uncertain",
  );
  const approved: TransferBatch = {
    ...batch,
    id: "approved-not-started",
    status: "approved",
    mode: "single",
    selectedPokemonId: "b",
    entries: [{ pokemonId: "b", status: "pending", reason: null }],
  };
  store.put("transfer_batches", approved.id, approved);
  recoverInterruptedPhoneWork();
  const revoked = store.get<TransferBatch>("transfer_batches", approved.id)!;
  assert.equal(revoked.status, "paused");
  assert.equal(revoked.selectedPokemonId, null);
  assert.equal(revoked.approvedAt, null);
});
