import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { Scan } from "../src/lib/iphone-types";
import type { PhoneCapabilities, PhoneConnection } from "../src/lib/phone-connection";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pokekeep-phone-connection-test-"));
(globalThis as typeof globalThis & { __POGO_TEST_DATA_DIR__?: string }).__POGO_TEST_DATA_DIR__ = temp;
const store = await import("../src/lib/store");
const { captureOne } = await import("../src/lib/iphone-scan");
const { typeFilteredSearch } = await import("../src/lib/iphone-transfer");
const { createPhoneConnection, phoneConnectionKey } = await import("../src/lib/phone-connection");
const { defaultRuntimeConfig } = await import("../src/lib/runtime-config");
const { IphoneMcp } = await import("../src/lib/iphone-mcp");
const { DeviceMcp } = await import("../src/lib/device-mcp");
after(() => {
  store.db().close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const plain = path.join(temp, "plain-screen.png");
const bars = path.join(temp, "appraisal-screen.png");
await sharp({ create: { width: 600, height: 1304, channels: 3, background: "white" } })
  .png()
  .toFile(plain);
const ivBars = [920, 980, 1040]
  .map(
    (y) =>
      `<rect x="72" y="${y}" width="207" height="8" rx="4" fill="#dddde0"/><rect x="72" y="${y}" width="193" height="8" rx="4" fill="#f1a348"/>`,
  )
  .join("");
await sharp(Buffer.from(`<svg width="600" height="1304"><rect width="600" height="1304" fill="white"/>${ivBars}</svg>`))
  .png()
  .toFile(bars);

const screen = (file: string, id: string) => ({
  app: "com.nianticlabs.pokemongo",
  observation_id: id,
  image: { path: file, width: 600, height: 1304, pixel_to_point: [0.5, 0.5] },
  viewport: { width: 300, height: 652 },
});

function captureScan(id: string) {
  const stamp = new Date().toISOString();
  const scan: Scan = {
    id,
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
    apiUsage: { input: 0, output: 0, requests: 0, cached: 0, navigationRequests: 0, dataRequests: 0 },
    error: null,
    checkpointRequired: false,
    iphoneUseVersion: null,
  };
  store.put("scans", id, scan);
  return scan;
}

/** The observed tap number `barsOnTap` shows the bars; other taps show plain pages. */
function scanPhone(capabilities: PhoneCapabilities, barsOnTap = 2) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let taps = 0;
  let observes = 0;
  const phone = {
    backend: "device-mcp",
    capabilities,
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      if (name === "swipe") return { observation: screen(plain, "moves") };
      if (name === "tap") {
        taps++;
        if (args.observe === "none") return {};
        return { observation: screen(taps === barsOnTap ? bars : plain, `tap-${taps}`) };
      }
      if (name === "observe") {
        observes++;
        return screen(observes === 1 ? bars : plain, `observe-${observes}`);
      }
      throw new Error(`不應呼叫 ${name}`);
    },
    async typeSearch() {
      throw new Error("掃描不應輸入搜尋");
    },
    close() {},
  } as unknown as PhoneConnection;
  return { phone, calls };
}

test("盲點導航只截取資料畫面：選單、評價與關閉評價不截圖，評價取第一張可信畫面", async () => {
  // Menu, appraise and the intro tap are taps 1-3; the intro tap shows the bars.
  const { phone, calls } = scanPhone({ blindNavigation: true, singleAppraisalFrame: true }, 3);
  const scan = captureScan("blind-capture");
  const next = await captureOne(phone, scan, screen(plain, "top"));
  assert.deepEqual(calls.map((call) => call.name), ["swipe", "tap", "tap", "tap", "tap"]);
  assert.deepEqual(calls.slice(1).map((call) => call.args.observe), ["none", "none", "screenshot", "none"]);
  // Blind taps return no frame, so the following taps are planned from the moves frame.
  assert.equal(calls[2].args.observation_id, "moves");
  assert.equal(calls[3].args.observation_id, "moves");
  assert.equal(next.observation_id, "tap-3");
  const items = store.all<{ scanId: string; measuredIV: number[] | null }>("scan_items")
    .filter((item) => item.scanId === scan.id);
  assert.equal(items.length, 1);
  assert.ok(items[0].measuredIV);
  assert.equal(store.get<Scan>("scans", scan.id)?.scanned, 1);
});

test("盲點模式下翻頁後仍顯示評價條就暫停，不截圖也不點擊", async () => {
  const { phone, calls } = scanPhone({ blindNavigation: true, singleAppraisalFrame: true });
  const scan = captureScan("blind-still-appraisal");
  await assert.rejects(() => captureOne(phone, scan, screen(bars, "next")), /評價條仍顯示/);
  assert.deepEqual(calls, []);
  assert.equal(store.get<Scan>("scans", scan.id)?.scanned, 0);
});

test("沒有盲點能力時維持每次點擊後截圖與評價雙重確認", async () => {
  const { phone, calls } = scanPhone({ blindNavigation: false, singleAppraisalFrame: false });
  const scan = captureScan("observed-capture");
  await captureOne(phone, scan, screen(plain, "top"));
  assert.deepEqual(calls.map((call) => call.name), ["swipe", "tap", "tap", "observe", "tap"]);
  assert.deepEqual(
    calls.filter((call) => call.name === "tap").map((call) => call.args.observe),
    ["screenshot", "screenshot", "screenshot"],
  );
});

test("放生搜尋預設透過手機連線輸入文字", async () => {
  const typed: string[] = [];
  const phone = {
    async typeSearch(query: string) {
      typed.push(query);
    },
  } as unknown as PhoneConnection;
  await typeFilteredSearch(phone, 25, ["background"], undefined, async () => {}, async () => {});
  assert.deepEqual(typed, ["25&!背卡"]);
});

test("依設定建立手機連線，只有連線相關設定改變才需要重新連線", () => {
  const base = { ...defaultRuntimeConfig };
  const iphone = createPhoneConnection(base);
  assert.ok(iphone instanceof IphoneMcp);
  assert.equal(iphone.backend, "iphone-use");
  assert.deepEqual(iphone.capabilities, { blindNavigation: false, singleAppraisalFrame: false });
  iphone.close();
  const device = createPhoneConnection({ ...base, phoneBackend: "device-mcp" });
  assert.ok(device instanceof DeviceMcp);
  assert.equal(device.backend, "device-mcp");
  device.close();

  const key = phoneConnectionKey(base);
  assert.equal(phoneConnectionKey({ ...base, apiKey: "sk-test", model: "other", analysisConcurrency: 2 }), key);
  for (const patch of [
    { phoneBackend: "device-mcp" as const },
    { iphoneUseRoot: "/tmp/other-iphone-use" },
    { iphoneUsePython: "/usr/bin/python3" },
    { deviceMcpExecutable: "/tmp/device-mcp" },
    { deviceMcpDevice: "iPhone 15" },
  ])
    assert.notEqual(phoneConnectionKey({ ...base, ...patch }), key, JSON.stringify(patch));
});
