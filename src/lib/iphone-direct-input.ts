import { spawn } from "node:child_process";
import path from "node:path";
import { iphoneUseEntrypoint } from "./iphone-mcp";
import { getRuntimeConfig } from "./runtime-config";

/** Unicode search entry for Pokémon GO's custom field, serialized with iPhone Use. */
export function injectSearchText(query: string): Promise<void> {
  const match = query.match(/^([1-9]\d{0,4})(?:&!?背卡)?$/);
  if (!match || Number(match[1]) > 10000)
    throw new Error("只允許圖鑑編號與背卡搜尋");
  const root = iphoneUseEntrypoint().root;
  return new Promise((resolve, reject) => {
    const child = spawn(
      getRuntimeConfig().iphoneUsePython,
      [path.join(process.cwd(), "scripts", "iphone-type-search.py"), root],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("直接輸入逾時，送出狀態不明；已停止且不自動重送"));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024) {
        child.kill();
        reject(new Error("直接輸入回應過長；已停止且不自動重送"));
      }
    });
    child.stderr.on("data", () => { /* Do not print WDA or device details. */ });
    child.stdin.on("error", () => { /* Child exit reports the failure. */ });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        let detail = "直接輸入失敗，送出狀態不明；已停止且不自動重送";
        try {
          const response = JSON.parse(output) as { error?: string };
          if (response.error) detail = response.error;
        } catch {}
        reject(new Error(detail));
        return;
      }
      try {
        if ((JSON.parse(output) as { sent?: boolean }).sent === true) resolve();
        else reject(new Error("直接輸入結果不明；已停止且不自動重送"));
      } catch {
        reject(new Error("直接輸入結果不明；已停止且不自動重送"));
      }
    });
    child.stdin.end(JSON.stringify({ query }) + "\n");
  });
}
