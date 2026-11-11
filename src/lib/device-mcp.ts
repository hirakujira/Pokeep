import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { PhoneCapabilities, PhoneConnection } from "./phone-connection";
import { allowedPhoneSearchQuery } from "./transfer-search-filters";

type Result = {
  content?: { type: string; text?: string }[];
  isError?: boolean;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type PhoneError = Error & { code?: string; uncertain?: boolean; detail?: string };
type Viewport = { width: number; height: number };
type Observation = {
  app: string;
  observation_id: string;
  image?: {
    path: string;
    width: number;
    height: number;
    pixel_to_point: [number, number];
  };
  viewport: Viewport;
};
type DeviceInfo = { locked: boolean; inputReady: boolean; viewport: Viewport | null };

export type DeviceMcpOptions = {
  executable: string;
  /** Device name or UDID; empty uses the device selected in Device MCP. */
  device: string;
  /** Private folder for screenshots. */
  imageDir?: string;
};

// Calibrated on Pokémon GO menus: a second tap 70 ms after the first is
// dropped while the menu animates. Measured from the end of the previous input.
export const MIN_INPUT_GAP_MS = 700;
// Same bounds and output size as iPhone Use's wda_image.py, so OCR and IV
// calibration made on iPhone Use screenshots stay valid.
const MAX_SHORT_SIDE = 768;
const MAX_LONG_SIDE = 1568;
// iPhone Use encodes with `sips formatOptions 80`; sharp needs about 90 to
// reach the same file size and detail.
const JPEG_QUALITY = 90;
const KEPT_SCREENSHOTS = 32;
const SPRINGBOARD = "com.apple.springboard";
const LAUNCH_VERIFY_MS = 10_000;
// Fractions of the screen in points, calibrated on Gungnir (402x874 pt).
const SWIPES = {
  left: { from: [0.724, 0.5], to: [0.276, 0.5] },
  up: { from: [0.5, 0.66], to: [0.5, 0.34] },
} as const;
const SWIPE_DURATION_MS = 100;

const SCREENSHOT_NAME = /^\d{13}-\d{6}-[0-9a-f]{8}\.(png|jpg)$/;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function fitSize(width: number, height: number): [number, number] {
  const scale = Math.min(
    1,
    MAX_SHORT_SIDE / Math.min(width, height),
    MAX_LONG_SIDE / Math.max(width, height),
  );
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

function fold(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function markUncertain(error: unknown) {
  const phoneError = (
    error instanceof Error ? error : new Error(String(error))
  ) as PhoneError;
  phoneError.code = "action_uncertain";
  phoneError.uncertain = true;
  return phoneError;
}

export function deviceMcpVersion(executable: string): string {
  if (!executable || !fs.existsSync(executable))
    throw new Error(`找不到 Device MCP：${executable}。請到網頁「設定」頁指定位置。`);
  const plist = path.resolve(path.dirname(executable), "..", "Info.plist");
  try {
    const content = fs.readFileSync(plist, "utf8");
    const version = content.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    if (version) return version.trim();
    // Binary property lists are not readable as text.
    return (
      execFileSync(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}

export class DeviceMcp implements PhoneConnection {
  readonly backend = "device-mcp" as const;
  readonly capabilities: PhoneCapabilities = {
    blindNavigation: true,
    singleAppraisalFrame: true,
  };
  /** serverInfo.version from the last initialize. */
  serverVersion: string | null = null;
  private readonly executable: string;
  private readonly device: string;
  private readonly imageDir: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connecting: Promise<void> | null = null;
  private sequence = 0;
  private shots = 0;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private viewport: Viewport | null = null;
  private lastInputEnd = 0;
  private inputChain: Promise<unknown> = Promise.resolve();

  constructor(options: DeviceMcpOptions) {
    this.executable = options.executable;
    this.device = options.device.trim();
    this.imageDir =
      options.imageDir || path.join(os.tmpdir(), "pokeep-device-mcp");
  }

  private connect() {
    if (!this.connecting)
      this.connecting = this.start().catch((error) => {
        this.close();
        throw error;
      });
    return this.connecting;
  }

  private async start() {
    if (!fs.existsSync(this.executable))
      throw new Error(
        `找不到 Device MCP：${this.executable}。請到網頁「設定」頁指定位置。`,
      );
    const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.on("data", () => {
      /* drain diagnostics without exposing device logs */
    });
    child.stdin.on("error", () => {
      /* exit reports the failure */
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      this.buffer += data;
      for (
        let end = this.buffer.indexOf("\n");
        end >= 0;
        end = this.buffer.indexOf("\n")
      ) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error)
            pending.reject(new Error(message.error.message || "MCP 呼叫失敗"));
          else pending.resolve(message.result);
        } catch {
          /* invalid lines never become commands */
        }
      }
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.connecting = null;
      }
      this.failAll(new Error("Device MCP 背景服務已離線"));
    });
    const initialized = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pokeep", version: "0.1.0" },
    })) as { serverInfo?: { version?: string } } | undefined;
    this.serverVersion = initialized?.serverInfo?.version || null;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
  }

  private failAll(error: Error) {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(key);
    }
  }

  private request(method: string, params: unknown, timeout = 120000) {
    if (!this.child) throw new Error("Device MCP 背景服務未連接");
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 逾時；手機動作可能已執行，必須先查狀態`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  /** One Device MCP tool call; returns its plain-text answer. */
  private async tool(
    name: string,
    args: Record<string, unknown> = {},
    timeout = 60000,
  ) {
    await this.connect();
    const result = (await this.request(
      "tools/call",
      { name, arguments: this.device ? { ...args, device: this.device } : args },
      timeout,
    )) as Result | undefined;
    const text = (result?.content || [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (result?.isError) {
      const detail = text.replace(/^Error:\s*/, "") || "未知錯誤";
      const error = new Error(`Device MCP ${name} 失敗：${detail}`) as PhoneError;
      error.code = "device_mcp_error";
      error.detail = detail;
      throw error;
    }
    return text;
  }

  /** Serializes input and keeps MIN_INPUT_GAP_MS after the previous one ends. */
  private async input<T>(run: () => Promise<T>): Promise<T> {
    await this.connect();
    const next = this.inputChain.then(async () => {
      const wait = this.lastInputEnd + MIN_INPUT_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await run();
      } catch (error) {
        throw markUncertain(error);
      } finally {
        this.lastInputEnd = Date.now();
      }
    });
    this.inputChain = next.catch(() => undefined);
    return next;
  }

  private async deviceInfo(timeout?: number): Promise<DeviceInfo> {
    const text = await this.tool("get_device_info", {}, timeout);
    const points = text.match(/^screen_points:\s*(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/m);
    const viewport = points
      ? { width: Number(points[1]), height: Number(points[2]) }
      : null;
    if (viewport) this.viewport = viewport;
    return {
      locked: /^locked:\s*yes\b/im.test(text),
      inputReady: !/input_ready:\s*false\b/i.test(text),
      viewport,
    };
  }

  private async currentViewport(timeout?: number) {
    if (this.viewport) return this.viewport;
    const { viewport } = await this.deviceInfo(timeout);
    if (!viewport) throw new Error("Device MCP 沒有回傳螢幕尺寸");
    return viewport;
  }

  private async foregroundApp(timeout?: number) {
    const text = await this.tool("get_foreground_app", {}, timeout);
    if (/^app:\s*none\b/im.test(text)) return SPRINGBOARD;
    return text.match(/^bundle_id:\s*(\S+)/m)?.[1] || SPRINGBOARD;
  }

  private screenshotPath() {
    fs.mkdirSync(this.imageDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.imageDir, 0o700);
    const stamp = `${Date.now()}-${String(++this.shots % 1_000_000).padStart(6, "0")}`;
    return path.join(this.imageDir, `${stamp}-${randomUUID().slice(0, 8)}.png`);
  }

  private prune() {
    const files = fs
      .readdirSync(this.imageDir)
      .filter((name) => SCREENSHOT_NAME.test(name))
      .sort();
    for (const name of files.slice(0, -KEPT_SCREENSHOTS))
      fs.rmSync(path.join(this.imageDir, name), { force: true });
  }

  private async screenshot(viewport: Viewport, timeout?: number) {
    const source = this.screenshotPath();
    await this.tool("save_screenshot", { path: source, overwrite: true }, timeout);
    const meta = await sharp(source).metadata();
    if (!meta.width || !meta.height) throw new Error("Device MCP 截圖缺少尺寸");
    if (meta.width > meta.height !== viewport.width > viewport.height)
      viewport = await this.deviceInfo(timeout).then(
        (info) => info.viewport || viewport,
      );
    const [width, height] = fitSize(meta.width, meta.height);
    let file = source;
    if (width !== meta.width || height !== meta.height) {
      file = source.replace(/\.png$/, ".jpg");
      await sharp(source)
        .resize(width, height, { fit: "fill" })
        .jpeg({ quality: JPEG_QUALITY })
        .toFile(file);
      fs.rmSync(source, { force: true });
    }
    fs.chmodSync(file, 0o600);
    this.prune();
    return {
      viewport,
      image: {
        path: file,
        width,
        height,
        pixel_to_point: [
          Math.round((viewport.width / width) * 10000) / 10000,
          Math.round((viewport.height / height) * 10000) / 10000,
        ] as [number, number],
      },
    };
  }

  private async observation(withImage: boolean, timeout?: number) {
    const viewport = await this.currentViewport(timeout);
    // Device MCP answers concurrent requests; the foreground check costs
    // little next to the screenshot.
    const [app, shot] = await Promise.all([
      this.foregroundApp(timeout),
      withImage ? this.screenshot(viewport, timeout) : null,
    ]);
    const observation: Observation = {
      app,
      observation_id: `dm-${randomUUID()}`,
      viewport: shot?.viewport || viewport,
    };
    if (shot) observation.image = shot.image;
    return observation;
  }

  private async afterInput(observe: unknown, timeout?: number) {
    return observe === "screenshot"
      ? { observation: await this.observation(true, timeout) }
      : {};
  }

  async call<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
    timeout?: number,
  ): Promise<T> {
    return (await this.dispatch(name, args, timeout)) as T;
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
    timeout?: number,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case "setup": {
        try {
          await this.deviceInfo(timeout);
        } catch (error) {
          const detail = (error as PhoneError).detail;
          if (!detail) throw error;
          return { ok: false, error: `Device MCP 找不到裝置：${detail}` };
        }
        return { ok: true, configured: true, service: { ready: true, reachable: true } };
      }
      case "ready": {
        const info = await this.deviceInfo(timeout);
        if (info.locked) return { ready: false, state: "iPhone 已鎖定，請解鎖" };
        if (!info.inputReady)
          return { ready: false, state: "Device MCP 尚未能操作 iPhone，請確認 USB 連接" };
        return {
          ready: true,
          observation: await this.observation(args.screenshot !== false, timeout),
        };
      }
      case "observe":
        return this.observation(true, timeout);
      case "tap": {
        const { x, y } = args;
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
          throw new Error("點擊座標無效");
        await this.input(() => this.tool("tap", { x, y }, timeout));
        return this.afterInput(args.observe, timeout);
      }
      case "swipe": {
        const direction = args.direction;
        if (direction !== "up" && direction !== "left")
          throw new Error(`Device MCP 不支援的滑動方向：${String(direction)}`);
        const viewport = await this.currentViewport(timeout);
        const { from, to } = SWIPES[direction];
        await this.input(() =>
          this.tool(
            "swipe",
            {
              from_x: Math.round(from[0] * viewport.width),
              from_y: Math.round(from[1] * viewport.height),
              to_x: Math.round(to[0] * viewport.width),
              to_y: Math.round(to[1] * viewport.height),
              duration_ms: SWIPE_DURATION_MS,
            },
            timeout,
          ),
        );
        return this.afterInput(args.observe, timeout);
      }
      case "apps": {
        const text = await this.tool("list_apps", { include_system: false }, timeout);
        const query = typeof args.query === "string" ? fold(args.query.trim()) : "";
        const limit =
          typeof args.limit === "number" && args.limit > 0 ? args.limit : Infinity;
        const candidates = text
          .split("\n")
          .map((line) => line.trim().match(/^(.+?) — (\S+)(?: \(([^)]*)\))?$/))
          .filter((match): match is RegExpMatchArray => !!match)
          .map((match) => ({
            name: match[1],
            bundle_id: match[2],
            installed_verified: true,
          }))
          .filter(
            (row) =>
              !query ||
              fold(row.name).includes(query) ||
              fold(row.bundle_id).includes(query),
          )
          .slice(0, limit);
        return { candidates };
      }
      case "launch_app": {
        const bundle = args.bundle_id;
        if (typeof bundle !== "string" || !bundle)
          throw new Error("缺少要開啟的 App bundle id");
        await this.tool("launch_app", { bundle_id: bundle }, timeout);
        if (args.verify) {
          const deadline = Date.now() + LAUNCH_VERIFY_MS;
          while ((await this.foregroundApp(timeout)) !== bundle) {
            if (Date.now() >= deadline) {
              const error = new Error(
                `已要求開啟 ${bundle}，但它沒有在 10 秒內成為前景 App`,
              ) as PhoneError;
              error.code = "launch_unverified";
              throw error;
            }
            await sleep(500);
          }
        }
        return {};
      }
      default: {
        const error = new Error(`Device MCP 不支援 ${name}`) as PhoneError;
        error.code = "unsupported_tool";
        throw error;
      }
    }
  }

  /** Pastes into the already focused Pokémon GO search field without submitting. */
  async typeSearch(query: string): Promise<void> {
    if (!allowedPhoneSearchQuery(query))
      throw new Error("只允許圖鑑編號與已核准的放生搜尋條件");
    await this.input(async () => {
      // type_text pastes each non-ASCII run separately; iOS then inserts a
      // smart space before every run (breaking the `!` filter), and its paste
      // banner swallows the arrow keys that could remove it. One paste of the
      // whole query into the emptied field gets no smart space and is much
      // faster than typing, which takes over half a second per character.
      await this.tool("type_text", { text: "", clear: true }, 20000);
      await this.tool("set_clipboard", { text: query }, 20000);
      await this.tool("press_key", { key: "v", modifiers: ["command"] }, 20000);
    });
  }

  close() {
    this.child?.kill();
    this.child = null;
    this.connecting = null;
    this.failAll(new Error("Device MCP 背景服務已關閉"));
  }
}
