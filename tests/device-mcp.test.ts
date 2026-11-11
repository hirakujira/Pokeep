import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DeviceMcp, deviceMcpVersion, MIN_INPUT_GAP_MS } from "../src/lib/device-mcp";

type Call = { name: string; args: Record<string, unknown>; start: number; end: number };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pokekeep-device-mcp-"));
const bundle = path.join(root, "Device MCP.app", "Contents");
const executable = path.join(bundle, "MacOS", "device-mcp");
const statePath = path.join(root, "state.json");
const logPath = path.join(root, "calls.jsonl");
const fixture = path.join(root, "screen.png");
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(
  path.join(bundle, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Device MCP</string>
<key>CFBundleShortVersionString</key>
<string>0.12.0</string>
</dict></plist>
`,
);
await sharp({
  create: { width: 1206, height: 2622, channels: 3, background: "#3070b0" },
})
  .png()
  .toFile(fixture);

// Plain-text answers in the format the real Device MCP 0.12 returns.
fs.writeFileSync(
  executable,
  `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
let foreground = null;
const state = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return {}; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
async function handle(name, args) {
  const s = state();
  if (s.noDevice && name !== "list_apps") return [true, 'Error: No device matches "' + (args.device || "") + '".'];
  switch (name) {
    case "get_device_info":
      return [false, "name: MockPhone\\nmodel: iPhone 17 Pro (iPhone18,1)\\nos: iOS 27.0.1\\nconnection: USB\\nscreen_points: 402x874\\nengine: Native (iOS 27), mirror: CoreDevice HEVC 4:4:4 · USB @ 30 fps, input_ready: true\\nlocked: " + (s.locked ? "yes" : "no")];
    case "get_foreground_app": {
      const app = foreground || s.foreground || "com.nianticlabs.pokemongo";
      return [false, app === "none" ? "app: none" : "app: Pokémon GO\\nbundle_id: " + app + "\\npid: 9012"];
    }
    case "save_screenshot":
      if (fs.existsSync(args.path) && !args.overwrite) return [true, "Error: " + args.path + " exists already."];
      fs.copyFileSync(s.png, args.path);
      return [false, "Saved MockPhone's screen (1206x2622 pixels, PNG, 1 MB) to " + args.path];
    case "tap":
      await sleep(30);
      if (s.failTap) return [true, "Error: The device stopped answering."];
      return [false, "Tapped (" + args.x + ", " + args.y + ")"];
    case "swipe":
      await sleep(30);
      return [false, "Swiped"];
    case "type_text":
      if (s.typeError) return [true, "Error: No text field has the focus."];
      if (/[^\\x00-\\x7f]/.test(args.text)) return [true, "Error: iOS is asking whether to allow pasting from Device MCP. Tap Allow Paste on the device."];
      return [false, "Typed " + args.text.length + " characters"];
    case "set_clipboard":
      return [false, "Put " + args.text.length + " characters on MockPhone's clipboard."];
    case "press_key":
      return [false, "Pressed " + args.key];
    case "list_apps":
      return [false, "1Password — com.1password.1password (8.12.44)\\nPokémon GO — com.nianticlabs.pokemongo (0.435.2)\\nPokemon Sleep — jp.pokemon.pokemonsleep (2.1.0)\\nTimon — org.timon.cards (248)"];
    case "launch_app":
      setTimeout(() => { foreground = args.bundle_id; }, s.launchDelay || 0);
      return [false, "Launched " + args.bundle_id];
    default:
      return [true, "Unknown tool: " + name];
  }
}
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Device MCP", version: "0.12.0" } } });
    return;
  }
  const { name, arguments: args = {} } = request.params;
  const start = Date.now();
  const [isError, text] = await handle(name, args);
  fs.appendFileSync(logPath, JSON.stringify({ name, args, start, end: Date.now() }) + "\\n");
  send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }], isError } });
});
`,
  { mode: 0o755 },
);

function setState(state: Record<string, unknown>) {
  fs.writeFileSync(statePath, JSON.stringify({ png: fixture, ...state }));
}
function calls(): Call[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function fresh(state: Record<string, unknown> = {}, device = "MockPhone") {
  setState(state);
  fs.rmSync(logPath, { force: true });
  const imageDir = fs.mkdtempSync(path.join(root, "images-"));
  return { phone: new DeviceMcp({ executable, device, imageDir }), imageDir };
}
type Obs = {
  app: string;
  observation_id: string;
  image?: { path: string; width: number; height: number; pixel_to_point: number[] };
  viewport: { width: number; height: number };
};

test("setup 與 ready 對應 iPhone Use 的回傳形狀", async () => {
  const { phone } = fresh();
  try {
    assert.equal(phone.backend, "device-mcp");
    assert.deepEqual(phone.capabilities, { blindNavigation: true, singleAppraisalFrame: true });
    assert.deepEqual(await phone.call("setup", { action: "status" }), {
      ok: true,
      configured: true,
      service: { ready: true, reachable: true },
    });
    assert.equal(phone.serverVersion, "0.12.0");
    const ready = await phone.call<{ ready: boolean; observation: Obs }>("ready", {
      recover: true,
      screenshot: false,
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.observation.app, "com.nianticlabs.pokemongo");
    assert.deepEqual(ready.observation.viewport, { width: 402, height: 874 });
    assert.equal(ready.observation.image, undefined);
    assert.ok(ready.observation.observation_id);
    assert.ok(!calls().some((call) => call.name === "save_screenshot"));
    const withImage = await phone.call<{ observation: Obs }>("ready", {});
    assert.ok(withImage.observation.image?.path);

    setState({ locked: true });
    assert.deepEqual(await phone.call("ready", { screenshot: false }), {
      ready: false,
      state: "iPhone 已鎖定，請解鎖",
    });

    setState({ noDevice: true });
    const failed = await phone.call<{ ok: boolean; error: string }>("setup", { action: "status" });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /^Device MCP 找不到裝置/);
    assert.match(failed.error, /No device matches "MockPhone"/);
  } finally {
    phone.close();
  }
});

test("observe 截圖縮成 iPhone Use 的尺寸並回報座標比例與前景 App", async () => {
  const { phone, imageDir } = fresh();
  try {
    const observation = await phone.call<Obs>("observe", { mode: "screenshot" });
    assert.equal(observation.app, "com.nianticlabs.pokemongo");
    assert.deepEqual(observation.viewport, { width: 402, height: 874 });
    assert.equal(observation.image!.width, 721);
    assert.equal(observation.image!.height, 1568);
    assert.deepEqual(observation.image!.pixel_to_point, [0.5576, 0.5574]);
    assert.match(observation.image!.path, /\.jpg$/);
    assert.equal(path.dirname(observation.image!.path), imageDir);
    const meta = await sharp(observation.image!.path).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 721);
    assert.equal(meta.height, 1568);
    assert.equal(fs.statSync(imageDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(observation.image!.path).mode & 0o777, 0o600);
    assert.ok(!fs.readdirSync(imageDir).some((name) => name.endsWith(".png")));

    const second = await phone.call<Obs>("observe", {});
    assert.notEqual(second.observation_id, observation.observation_id);
    assert.notEqual(second.image!.path, observation.image!.path);

    setState({ foreground: "none" });
    assert.equal((await phone.call<Obs>("observe", {})).app, "com.apple.springboard");

    for (let index = 0; index < 34; index++) await phone.call("observe", {});
    const kept = fs.readdirSync(imageDir);
    assert.equal(kept.length, 32);
    assert.ok(!kept.includes(path.basename(observation.image!.path)));
  } finally {
    phone.close();
  }
});

test("點擊與滑動換算成螢幕點並維持最小輸入間隔", async () => {
  const { phone } = fresh();
  try {
    assert.deepEqual(
      await phone.call("tap", { x: 201.5, y: 822, observation_id: "old", observe: "none" }),
      {},
    );
    assert.deepEqual(await phone.call("tap", { x: 348, y: 822, observation_id: "old" }), {});
    const swiped = await phone.call<{ observation: Obs }>("swipe", {
      direction: "left",
      observation_id: "old",
      verify: false,
      observe: "screenshot",
    });
    assert.equal(swiped.observation.image!.width, 721);
    await phone.call("swipe", { direction: "up", verify: false });
    const tapped = await phone.call<{ observation: Obs }>("tap", { x: 10, y: 20, observe: "screenshot" });
    assert.equal(tapped.observation.app, "com.nianticlabs.pokemongo");

    const log = calls();
    const inputs = log.filter((call) => call.name === "tap" || call.name === "swipe");
    assert.deepEqual(
      inputs.map(({ name, args }) => ({ name, args })),
      [
        { name: "tap", args: { x: 201.5, y: 822, device: "MockPhone" } },
        { name: "tap", args: { x: 348, y: 822, device: "MockPhone" } },
        { name: "swipe", args: { from_x: 291, from_y: 437, to_x: 111, to_y: 437, duration_ms: 100, device: "MockPhone" } },
        { name: "swipe", args: { from_x: 201, from_y: 577, to_x: 201, to_y: 297, duration_ms: 100, device: "MockPhone" } },
        { name: "tap", args: { x: 10, y: 20, device: "MockPhone" } },
      ],
    );
    for (let index = 1; index < inputs.length; index++)
      assert.ok(
        inputs[index].start - inputs[index - 1].end >= MIN_INPUT_GAP_MS - 5,
        `input ${index} started ${inputs[index].start - inputs[index - 1].end} ms after the previous one`,
      );
    // The screenshot after an input is not delayed by the input gap.
    const swipeIndex = log.findIndex((call) => call.name === "swipe");
    const shot = log.slice(swipeIndex).find((call) => call.name === "save_screenshot")!;
    assert.ok(shot.start - log[swipeIndex].end < MIN_INPUT_GAP_MS / 2);
    await assert.rejects(phone.call("swipe", { direction: "down" }));
  } finally {
    phone.close();
  }
});

test("同時送出的點擊仍依序並保持間隔", async () => {
  const { phone } = fresh();
  try {
    await Promise.all([
      phone.call("tap", { x: 1, y: 1 }),
      phone.call("tap", { x: 2, y: 2 }),
    ]);
    const taps = calls().filter((call) => call.name === "tap");
    assert.equal(taps.length, 2);
    assert.ok(taps[1].start - taps[0].end >= MIN_INPUT_GAP_MS - 5);
  } finally {
    phone.close();
  }
});

test("apps 解析已安裝清單並以不分大小寫與重音比對", async () => {
  const { phone } = fresh();
  try {
    const apps = await phone.call<{ candidates: unknown[] }>("apps", {
      query: "Pokémon GO",
      source: "installed",
      limit: 10,
    });
    assert.deepEqual(apps.candidates, [
      { name: "Pokémon GO", bundle_id: "com.nianticlabs.pokemongo", installed_verified: true },
    ]);
    const loose = await phone.call<{ candidates: { bundle_id: string }[] }>("apps", { query: "POKEMON" });
    assert.deepEqual(
      loose.candidates.map((row) => row.bundle_id),
      ["com.nianticlabs.pokemongo", "jp.pokemon.pokemonsleep"],
    );
    assert.deepEqual(calls()[0].args, { include_system: false, device: "MockPhone" });
  } finally {
    phone.close();
  }
});

test("launch_app verify 會等到 App 成為前景", async () => {
  const { phone } = fresh({ foreground: "none", launchDelay: 800 });
  try {
    assert.deepEqual(
      await phone.call("launch_app", { bundle_id: "com.nianticlabs.pokemongo", verify: true }),
      {},
    );
    const log = calls();
    assert.deepEqual(log[0].args, { bundle_id: "com.nianticlabs.pokemongo", device: "MockPhone" });
    assert.ok(log.filter((call) => call.name === "get_foreground_app").length >= 2);
  } finally {
    phone.close();
  }
});

test("typeSearch 清空欄位後整串貼上，避免 iOS 在中文前插入空格", async () => {
  const { phone } = fresh();
  try {
    await assert.rejects(
      phone.typeSearch("25&!hello"),
      /只允許圖鑑編號與已核准的放生搜尋條件/,
    );
    await assert.rejects(phone.typeSearch("abc"), /只允許圖鑑編號與已核准的放生搜尋條件/);
    assert.deepEqual(calls(), []);

    await phone.typeSearch("25&!背卡&!我的最愛&!4*");
    assert.deepEqual(
      calls().map(({ name, args }) => ({ name, args })),
      [
        { name: "type_text", args: { text: "", clear: true, device: "MockPhone" } },
        { name: "set_clipboard", args: { text: "25&!背卡&!我的最愛&!4*", device: "MockPhone" } },
        { name: "press_key", args: { key: "v", modifiers: ["command"], device: "MockPhone" } },
      ],
    );

    setState({ typeError: true });
    await assert.rejects(
      phone.typeSearch("25"),
      (error: Error & { uncertain?: boolean }) =>
        error.uncertain === true && /No text field has the focus/.test(error.message),
    );
  } finally {
    phone.close();
  }
});

test("失敗的點擊標記為不確定，未知工具直接拒絕", async () => {
  const { phone } = fresh({ failTap: true });
  try {
    await assert.rejects(
      phone.call("tap", { x: 1, y: 2 }),
      (error: Error & { code?: string; uncertain?: boolean }) =>
        error.uncertain === true &&
        error.code === "action_uncertain" &&
        /Device MCP tap 失敗：The device stopped answering\./.test(error.message),
    );
    await assert.rejects(
      phone.call("no_such_tool", {}),
      (error: Error & { code?: string }) => error.code === "unsupported_tool",
    );
    setState({ noDevice: true });
    await assert.rejects(
      phone.call("observe", {}),
      (error: Error & { uncertain?: boolean }) =>
        error.uncertain === undefined && /No device matches/.test(error.message),
    );
  } finally {
    phone.close();
  }
});

test("未設定裝置時不傳 device 參數", async () => {
  const { phone } = fresh({}, "  ");
  try {
    await phone.call("setup", { action: "status" });
    await phone.call("observe", {});
    const log = calls();
    assert.ok(log.length >= 3);
    for (const call of log) assert.equal("device" in call.args, false);
  } finally {
    phone.close();
  }
});

test("deviceMcpVersion 讀取 App bundle 版本並在找不到時提示設定", async () => {
  assert.equal(deviceMcpVersion(executable), "0.12.0");
  const missing = path.join(root, "Missing.app", "Contents", "MacOS", "device-mcp");
  assert.throws(
    () => deviceMcpVersion(missing),
    new RegExp(`^Error: 找不到 Device MCP：${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}。請到網頁「設定」頁指定位置。$`),
  );
  const phone = new DeviceMcp({ executable: missing, device: "" });
  await assert.rejects(phone.call("observe", {}), /找不到 Device MCP/);
  phone.close();
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
