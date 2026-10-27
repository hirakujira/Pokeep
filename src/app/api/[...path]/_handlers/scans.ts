import type { NextRequest } from "next/server";
import { z } from "zod";
import { get } from "@/lib/store";
import {
  activeBatch,
  activeScan,
  createScan,
  discardIncompleteScans,
  scanItems,
  scans,
  updateScan,
} from "@/lib/iphone-data";
import type { Scan } from "@/lib/iphone-types";
import { body, json } from "./http";

const startInput = z.object({ scope: z.enum(["results", "all"]) });
const controlInput = z.object({
  action: z.enum(["pause", "resume", "stop", "finish"]),
});

export const listScans = () => json(scans());
export async function discardScans() {
  return json(await discardIncompleteScans());
}
export async function startScan(req: NextRequest) {
  const { scope } = startInput.parse(await body(req));
  const worker = get<{ updatedAt: string }>("settings", "iphone-worker");
  if (!worker || Date.now() - Date.parse(worker.updatedAt) > 15000)
    throw new Error(
      "iPhone 背景服務尚未啟動，請用 npm run dev 或 npm start 啟動 Pokéep",
    );
  return json(createScan(scope), 201);
}
export async function scanById(req: NextRequest, id: string, rest: string[]) {
  const scan = get<Scan>("scans", id);
  if (!scan) return json({ error: "找不到掃描工作" }, 404);
  if (req.method === "GET" && rest.length === 0)
    return json({ ...scan, items: scanItems(scan.id) });
  if (req.method === "POST" && rest[0] === "control") {
    const { action } = controlInput.parse(await body(req));
    return json(controlScan(scan, action));
  }
}
function controlScan(scan: Scan, action: z.infer<typeof controlInput>["action"]) {
  if (action === "finish") {
    if (
      scan.status !== "paused" ||
      scan.phase === "analysis" ||
      scan.expected !== null ||
      !scan.scanned ||
      scanItems(scan.id).length !== scan.scanned
    )
      throw new Error("只能在總數未知且截圖檢查點完整時確認截圖結束");
    if (activeBatch()) throw new Error("放生工作進行中");
    return updateScan(scan.id, {
      phase: "analysis",
      status: "queued",
      stage: "已確認截圖結束，準備解析",
      checkpointRequired: false,
      error: null,
    });
  }
  if (action === "pause" && ["queued", "running"].includes(scan.status))
    return updateScan(scan.id, { status: "paused", stage: "已暫停" });
  if (
    action === "stop" &&
    ["queued", "running", "paused"].includes(scan.status)
  )
    return updateScan(scan.id, { status: "stopped", stage: "已停止" });
  if (action === "resume" && scan.status === "stopped" && scan.phase === "analysis") {
    if (activeScan() || activeBatch()) throw new Error("已有手機工作在執行");
    if (!scan.scanned || scanItems(scan.id).length !== scan.scanned ||
        (scan.expected !== null && scan.expected !== scan.scanned))
      throw new Error("截圖檢查點不完整，無法只繼續解析");
    return updateScan(scan.id, {
      status: "queued",
      stage: "截圖已完成，繼續解析已保存畫面",
      checkpointRequired: false,
      error: null,
    });
  }
  if (action === "resume" && scan.status === "paused") {
    if (activeBatch()) throw new Error("放生工作進行中");
    return updateScan(scan.id, {
      status: "queued",
      stage: "準備續掃",
      checkpointRequired: false,
      error: null,
    });
  }
  throw new Error("目前狀態不能執行此操作");
}
