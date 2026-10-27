import fs from "node:fs";
import path from "node:path";
import { activeBatch, activeScan } from "./iphone-data";
import { dataDir, db, get, listPokemon, remove, transaction } from "./store";

/** Clear personal collection evidence while keeping connection, preferences, and game data. */
export function clearPokemonData() {
  if (activeScan() || activeBatch())
    throw new Error("手機工作仍在執行，請先暫停或停止");
  const operation = get<{ updatedAt: string }>("settings", "iphone-operation");
  if (operation && Date.now() - Date.parse(operation.updatedAt) < 15_000)
    throw new Error("背景服務仍在處理畫面，請稍後再清除");

  const removedPokemon = listPokemon().length;
  transaction(() => {
    for (const table of [
      "pokemon",
      "observations",
      "scans",
      "scan_items",
      "transfer_batches",
      "vision_cache",
    ]) db().exec(`DELETE FROM ${table}`);
    remove("settings", "iphone-prepare");
    remove("settings", "iphone-operation");
  });
  try {
    fs.rmSync(path.join(dataDir, "frames"), { recursive: true, force: true });
  } catch {
    throw new Error("寶可夢紀錄已清除，但截圖刪除失敗；請檢查 .data/frames");
  }
  return { removedPokemon };
}
