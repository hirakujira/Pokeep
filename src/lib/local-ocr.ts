import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./store";

export type OcrLine = {
  text: string;
  confidence: number;
  x: number;
  y: number;
};

type Pending = {
  resolve: (lines: OcrLine[][]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class LocalOcr {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private start() {
    if (this.child) return;
    if (process.platform !== "darwin")
      throw new Error("本機 OCR 需要 macOS Vision，無法開始解析");
    const cache = path.join(dataDir, "swift-module-cache");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    const script = path.join(process.cwd(), "scripts", "ocr.swift");
    const child = spawn("swift", [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SWIFT_MODULECACHE_PATH: cache,
        CLANG_MODULE_CACHE_PATH: cache,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", () => {
      /* Do not log image paths or private OCR data. */
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (
        let end = this.buffer.indexOf("\n");
        end >= 0;
        end = this.buffer.indexOf("\n")
      ) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        const pending = this.pending;
        this.pending = null;
        if (!pending) continue;
        clearTimeout(pending.timer);
        try {
          const reply = JSON.parse(line) as {
            lines?: OcrLine[][];
            error?: string;
          };
          if (reply.error || !reply.lines)
            throw new Error(reply.error || "本機 OCR 沒有回傳文字");
          pending.resolve(reply.lines);
        } catch (error) {
          pending.reject(error as Error);
        }
      }
    });
    const fail = () => {
      this.child = null;
      const pending = this.pending;
      this.pending = null;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("本機 OCR 背景程序已結束"));
      }
    };
    child.on("error", fail);
    child.on("exit", fail);
    process.once("exit", () => child.kill());
  }

  read(paths: string[]): Promise<OcrLine[][]> {
    const result = this.queue.then(() => {
      this.start();
      return new Promise<OcrLine[][]>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          this.child?.kill();
          this.child = null;
          reject(new Error("本機 OCR 逾時；截圖已保存，可稍後續跑解析"));
        }, 90000);
        this.pending = { resolve, reject, timer };
        this.child!.stdin.write(JSON.stringify({ paths }) + "\n");
      });
    });
    this.queue = result.catch(() => {});
    return result;
  }
}

const localOcr = new LocalOcr();

export function readLocalOcr(paths: string[]) {
  return localOcr.read(paths);
}

export function formatOcrLines(lines: OcrLine[], frame: "top" | "moves" | "appraisal") {
  return lines
    .filter((line) => {
      if (!line.text.trim()) return false;
      if (frame === "moves" && line.y < 0.1) return false;
      if (/^(?:20\d{2}|\d{1,2}[\/.]\d{1,2}|\d{4}[\/-]\d{1,2})$/.test(line.text.trim()))
        return false;
      if (/在.+捉到|捕獲地點|caught at/i.test(line.text))
        return false;
      return true;
    })
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((line) => `[${Math.round(line.x * 100)},${Math.round(line.y * 100)}] ${line.text}`)
    .join("\n");
}
