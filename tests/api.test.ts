import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { fixture, record } from "./fixtures";
import type { Job, Pokemon } from "../src/lib/types";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pogo-api-test-"));
process.env.POGO_DATA_DIR = temp;
delete process.env.OPENAI_API_KEY;
const route = await import("../src/app/api/[...path]/route");
const store = await import("../src/lib/store");
const { runMedia } = await import("../src/lib/video");
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
        "jobs",
        "POST",
        { name: "x" },
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
  const req = new NextRequest("http://localhost:3000/api/jobs", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "x-pogo-local": "1",
    },
    body: JSON.stringify({ name: "合法瀏覽器來源" }),
  });
  const response = await route.POST(req, {
    params: Promise.resolve({ path: ["jobs"] }),
  });
  assert.equal(response.status, 201);
});
test("狀態介面只回傳 API 是否設定，不暴露 key", async () => {
  process.env.OPENAI_API_KEY = "synthetic-never-a-real-secret";
  const response = await request("state"),
    text = await response.text();
  assert.ok(text.includes('"apiConfigured":true'));
  assert.ok(!text.includes("synthetic-never-a-real-secret"));
  delete process.env.OPENAI_API_KEY;
});
test("建立工作後沒有key不能啟動AI；可以取消清除暫存", async () => {
  const j = await (await request("jobs", "POST", { name: "無key測試" })).json();
  store.updateJob(j.id, {
    files: [
      {
        id: "missing",
        name: "test.mp4",
        path: "",
        size: 1,
        duration: 1,
        width: 600,
        height: 1304,
      },
    ],
  });
  const response = await request(`jobs/${j.id}/start`, "POST", {});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
  assert.equal((await request(`jobs/${j.id}/cancel`, "POST", {})).status, 200);
  assert.equal(store.get<Job>("jobs", j.id)?.status, "cancelled");
});
test("合成影片完整流程：串流上傳→抽幀→人工核對→結果→清除原片", async () => {
  const still = path.join(temp, "still.png"),
    video = path.join(temp, "sample.mp4");
  await sharp({
    create: { width: 600, height: 1304, channels: 3, background: "#f2f6ef" },
  })
    .png()
    .toFile(still);
  await runMedia([
    "-hide_banner",
    "-loglevel",
    "error",
    "-loop",
    "1",
    "-i",
    still,
    "-t",
    "0.75",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    video,
  ]);
  const job = await (
    await request("jobs", "POST", { name: "合成影片測試" })
  ).json();
  const upload = await request(
    `jobs/${job.id}/files?name=sample.mp4`,
    "PUT",
    fs.readFileSync(video),
  );
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.width, 600);
  const started = await request(`jobs/${job.id}/start`, "POST", {
    manual: true,
  });
  assert.equal(started.status, 200);
  const deadline = Date.now() + 15000;
  let latest: Job | null = null;
  while (Date.now() < deadline) {
    latest = store.get<Job>("jobs", job.id);
    if (latest && ["review", "failed"].includes(latest.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(latest?.status, "review", latest?.error || undefined);
  assert.equal(latest?.progress, 100);
  const pokemon = store.listPokemon().filter((p) => p.jobId === job.id);
  assert.ok(pokemon.length >= 1);
  assert.ok(
    pokemon.every((p) => p.analysis?.category === "review" && !p.verified),
  );
  assert.equal(fs.existsSync(uploaded.path), false);
  assert.ok(pokemon.every((p) => p.sources.length > 0));
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
