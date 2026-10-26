import fs from "node:fs";
import path from "node:path";
import { IphoneMcp, iphoneUseVersion } from "../src/lib/iphone-mcp";
import { runScan } from "../src/lib/iphone-scan";
import { runTransferBatch } from "../src/lib/iphone-transfer";
import { activeBatch, activeScan, updateScan } from "../src/lib/iphone-data";
import { dataDir, get, now, put } from "../src/lib/store";
import type { TransferBatch } from "../src/lib/iphone-types";
import { reevaluate } from "../src/lib/evaluate";
import { setPhoneUsageRecorder } from "../src/lib/iphone-vision";
import { recoverInterruptedPhoneWork } from "../src/lib/iphone-recovery";
import { getRuntimeConfig } from "../src/lib/runtime-config";

const lockPath = path.join(dataDir, "iphone-worker.lock");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let lock: number;
try {
  lock = fs.openSync(lockPath, "wx", 0o600);
} catch {
  const previous = Number(fs.readFileSync(lockPath, "utf8"));
  if (Number.isInteger(previous) && previous > 0) {
    try {
      process.kill(previous, 0);
      throw new Error("iPhone 背景服務已在執行");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  fs.rmSync(lockPath, { force: true });
  lock = fs.openSync(lockPath, "wx", 0o600);
}
fs.writeSync(lock, String(process.pid));
const cleanup = () => {
  fs.closeSync(lock);
  fs.rmSync(lockPath, { force: true });
};
process.once("exit", cleanup);

recoverInterruptedPhoneWork();
reevaluate();

const phone = new IphoneMcp();
let phoneConfig = JSON.stringify({
  root: getRuntimeConfig().iphoneUseRoot,
  python: getRuntimeConfig().iphoneUsePython,
});
let ready = false;
let message = "等待連接 iPhone";
let activeOperationId: string | null = null;
const heartbeat = setInterval(() => {
  try {
    let version: string | null = null;
    try {
      version = iphoneUseVersion();
    } catch {
      message = "找不到 iPhone Use，請到網頁「設定」頁指定位置";
    }
    put("settings", "iphone-worker", {
      updatedAt: now(),
      ready,
      message,
      version,
    });
    if (activeOperationId)
      put("settings", "iphone-operation", {
        scanId: activeOperationId,
        updatedAt: now(),
      });
  } catch (error) {
    // A concurrent API transaction can briefly hold SQLite's write lock.
    // Missing one heartbeat must not terminate the phone worker or web app.
    if ((error as Error & { errstr?: string }).errstr !== "database is locked")
      message = error instanceof Error ? error.message : "背景服務狀態更新失敗";
  }
}, 2000);

async function tick() {
  const nextPhoneConfig = JSON.stringify({
    root: getRuntimeConfig().iphoneUseRoot,
    python: getRuntimeConfig().iphoneUsePython,
  });
  if (nextPhoneConfig !== phoneConfig && !activeScan() && !activeBatch()) {
    phone.close();
    phoneConfig = nextPhoneConfig;
    ready = false;
    message = "iPhone Use 設定已更新，請重新準備連線";
  }
  const prepare = get<{ requestedAt: string }>("settings", "iphone-prepare");
  if (prepare) {
    put("settings", "iphone-prepare", null);
    try {
      const { ensureReady } = await import("../src/lib/iphone-scan");
      await ensureReady(phone);
      ready = true;
      message = "iPhone 已就緒";
    } catch (error) {
      ready = false;
      message = error instanceof Error ? error.message : "手機準備失敗";
    }
  }
  const scan = activeScan();
  if (scan) {
    activeOperationId = scan.id;
    put("settings", "iphone-operation", {
      scanId: scan.id,
      updatedAt: now(),
    });
    ready = false;
    message = scan.phase === "analysis" ? "正在解析已保存的截圖" : "正在截圖 Pokémon GO";
    setPhoneUsageRecorder((input, output) => {
      const latest = get<typeof scan>("scans", scan.id);
      if (latest)
        updateScan(scan.id, {
          apiUsage: {
            ...latest.apiUsage,
            input: latest.apiUsage.input + input,
            output: latest.apiUsage.output + output,
            requests: latest.apiUsage.requests + 1,
            navigationRequests:
              (latest.apiUsage.navigationRequests || 0) + 1,
          },
        });
    });
    try {
      await runScan(phone, scan);
      ready = true;
      message = "掃描已結束";
    } catch (error) {
      const latest = get<typeof scan>("scans", scan.id);
      if (latest && ["queued", "running"].includes(latest.status))
        updateScan(scan.id, {
          status: "paused",
          stage: "掃描已暫停",
          error: error instanceof Error ? error.message : "未知錯誤",
        });
      message = error instanceof Error ? error.message : "掃描失敗";
    } finally {
      setPhoneUsageRecorder(null);
      activeOperationId = null;
      put("settings", "iphone-operation", null);
    }
    return;
  }
  const batch = activeBatch();
  if (batch) {
    ready = false;
    message = "正在處理已確認的放生批次";
    try {
      await runTransferBatch(phone, batch);
      ready = true;
      message = "放生批次已結束";
    } catch (error) {
      const latest = get<TransferBatch>("transfer_batches", batch.id);
      if (latest && ["approved", "running"].includes(latest.status))
        put("transfer_batches", batch.id, {
          ...latest,
          status: "paused",
          selectedPokemonId: null,
          approvedAt: null,
          error: error instanceof Error ? error.message : "未知錯誤",
          updatedAt: now(),
        });
      message = error instanceof Error ? error.message : "放生批次已暫停";
    }
  }
}
async function main() {
  while (true) {
    try {
      await tick();
    } catch (error) {
      message = error instanceof Error ? error.message : "背景服務失敗";
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  phone.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  clearInterval(heartbeat);
  phone.close();
  process.exit(0);
});
void main();
