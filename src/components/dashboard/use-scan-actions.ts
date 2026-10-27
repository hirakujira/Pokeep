import { useState } from "react";
import type { Scan } from "@/lib/iphone-types";
import { api } from "./api";
import type { Notify, RunAction } from "./types";

export function useScanActions(phoneAct: RunAction, notify: Notify) {
  const [scanScope, setScanScope] = useState<"results" | "all">("results");
  const preparePhone = () => {
    void phoneAct("prepare-phone", async () => {
      await api("iphone/prepare", "POST");
      notify("正在檢查連線");
    });
  };
  const startScan = () => {
    void phoneAct("start-phone", async () => {
      await api("scans", "POST", { scope: scanScope });
      notify("掃描已開始");
    });
  };
  const controlScan = (label: string, scan: Scan, action: string, message?: string) => {
    void phoneAct(label, async () => {
      await api(
        `scans/${scan.id}/control`,
        "POST",
        { action },
      );
      if (message) notify(message);
    });
  };
  const pauseScan = (scan: Scan) => controlScan("pause-scan", scan, "pause");
  const resumeScan = (scan: Scan) => controlScan("resume-scan", scan, "resume");
  const finishCapture = (scan: Scan) => controlScan("finish-capture", scan, "finish", "開始解析");
  const stopScan = (scan: Scan) => controlScan("stop-scan", scan, "stop");
  const discardScans = (scan: Scan) => {
    void phoneAct("discard-scans", async () => {
      const result = await api<{
        discardedScans: number;
        discardedPokemon: number;
        frameCleanupFailed: number;
      }>("scans/discard", "POST");
      setScanScope(scan.scope);
      notify(
        `已清除 ${result.discardedScans} 筆未完成掃描及 ${result.discardedPokemon} 隻相關個體；請按「開始掃描」重來${result.frameCleanupFailed ? `。${result.frameCleanupFailed} 筆截圖未能清除` : ""}`,
      );
    });
  };
  return {
    scanScope,
    setScanScope,
    preparePhone,
    startScan,
    pauseScan,
    resumeScan,
    finishCapture,
    stopScan,
    discardScans,
  };
}
export type ScanActions = ReturnType<typeof useScanActions>;
