import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fixture, record, species, settings } from "./fixtures";
import { emptyFields, type Observation } from "../src/lib/types";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pogo-test-"));
process.env.POGO_DATA_DIR = temp;
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
const { measureIV, probeVideo } = await import("../src/lib/video");
const store = await import("../src/lib/store");
const { exportBackup, importBackup, exportCsv, validFrame } =
  await import("../src/lib/backup");
after(() => {
  store.db().close();
  fs.rmSync(temp, { recursive: true, force: true });
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
test("同種色違各留代表，已放生個體不佔名額", () => {
  const s = fixture(),
    a = record("a", { shiny: true }),
    b = record("b", { shiny: true });
  const rows = evaluateCollection([a, b], s, settings);
  assert.equal(
    rows.filter((p) => p.analysis?.category === "collect").length,
    1,
  );
  assert.equal(
    rows.filter((p) => p.analysis?.category === "transfer").length,
    1,
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
  }
});
test("無法解碼的影片有明確錯誤", async () => {
  const file = path.join(temp, "broken.mp4");
  fs.writeFileSync(file, "not a video");
  await assert.rejects(() => probeVideo(file), /無法解碼/);
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
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(
    () =>
      recognize("test/one.jpg", null, new AbortController().signal, () => {}),
    /OPENAI_API_KEY/,
  );
});
test("Responses API 結構化辨識會重試429、記錄用量並快取相同畫面", async () => {
  const original = globalThis.fetch,
    originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-not-a-real-key";
  let calls = 0;
  const parsed = {
    kind: "appraisal",
    fields: record("response").fields,
    issues: [],
    clear: true,
  };
  globalThis.fetch = async () => {
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
    assert.deepEqual(usage[1], { input: 0, output: 0, cached: true });
  } finally {
    globalThis.fetch = original;
    if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    else delete process.env.OPENAI_API_KEY;
  }
});
test("AI 等候重試時可以取消，不繼續產生請求", async () => {
  const original = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-not-a-real-key";
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
    delete process.env.OPENAI_API_KEY;
  }
});
test("完整備份可還原且重複匯入不覆蓋人工修正", async () => {
  store.saveSnapshot(fixture());
  const p = record("backup");
  store.put("pokemon", p.id, p);
  const backup = await exportBackup();
  store.remove("pokemon", p.id);
  assert.equal((await importBackup(backup)).imported, 1);
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
