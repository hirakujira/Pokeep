import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getRuntimeConfig } from "./runtime-config";

type Result = {
  content?: { type: string; text?: string }[];
  isError?: boolean;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function iphoneUseEntrypoint() {
  const root = getRuntimeConfig().iphoneUseRoot;
  const file = path.join(root, "server", "iphone_use.py");
  if (!fs.existsSync(file))
    throw new Error(`找不到 iPhone Use：${file}。請到網頁「設定」頁指定位置。`);
  return { root, file };
}

export function iphoneUseVersion() {
  const { file } = iphoneUseEntrypoint();
  const content = fs.readFileSync(file, "utf8");
  const version = content.match(/^VERSION="([^"]+)"/m)?.[1] || "unknown";
  return `${version} (${createHash("sha256").update(content).digest("hex").slice(0, 12)})`;
}

export class IphoneMcp {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private buffer = "";
  private pending = new Map<number, Pending>();
  async connect() {
    if (this.child) return;
    const { root, file } = iphoneUseEntrypoint();
    const child = spawn(getRuntimeConfig().iphoneUsePython, [file], {
      cwd: root,
      env: { ...process.env, IPHONE_USE_ANALYTICS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", () => {
      /* drain diagnostics without exposing device logs */
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
          /* stderr and invalid lines never become commands */
        }
      }
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", () => {
      this.child = null;
      this.failAll(new Error("iPhone Use 背景服務已離線"));
    });
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pokekeep", version: "0.1.0" },
    });
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
    if (!this.child) throw new Error("iPhone Use 背景服務未連接");
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
  async call<T extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
    timeout?: number,
  ): Promise<T> {
    await this.connect();
    const result = (await this.request(
      "tools/call",
      { name: `pua_${name}`, arguments: args },
      timeout,
    )) as Result;
    const text = result.content?.find((block) => block.type === "text")?.text;
    if (!text) throw new Error(`iPhone Use ${name} 沒有回傳結果`);
    const data = JSON.parse(text) as T & {
      error?: string | { message?: string; code?: string; uncertain?: boolean };
    };
    if (result.isError || data.error) {
      const detail = typeof data.error === "object" ? data.error : null;
      const error = new Error(
        (typeof data.error === "string" ? data.error : detail?.message) ||
          `iPhone Use ${name} 失敗`,
      ) as Error & { code?: string; uncertain?: boolean };
      error.code = detail?.code;
      error.uncertain = detail?.uncertain;
      throw error;
    }
    return data;
  }
  close() {
    this.child?.kill();
    this.child = null;
  }
}
