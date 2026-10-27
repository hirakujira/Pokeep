import fs from "node:fs";
import path from "node:path";
import { reevaluate } from "../src/lib/evaluate";
import { activeBatch, activeScan } from "../src/lib/iphone-data";
import type { Scan, ScanItem } from "../src/lib/iphone-types";
import { readLocalOcr } from "../src/lib/local-ocr";
import { maxStatusFromScreenshot, type MaxStatus } from "../src/lib/max-status";
import { all, dataDir, get, now, put, transaction } from "../src/lib/store";
import type { Pokemon } from "../src/lib/types";

if (activeScan() || activeBatch())
  throw new Error("手機工作進行中，稍後再回填極巨化狀態");
const dryRun = process.argv.includes("--dry-run");
const eligible = (item: ScanItem, pokemon: Pokemon) => {
  const scan = get<Scan>("scans", item.scanId);
  return item.maxStatus == null && pokemon.maxStatus == null &&
    pokemon.jobId === item.scanId && scan?.status === "completed" &&
    Boolean(scan.completedAt && pokemon.updatedAt <= scan.completedAt);
};
const items = all<ScanItem>("scan_items")
  .filter((item) => item.pokemonId && item.frame && item.maxStatus == null)
  .filter((item) => {
    const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
    return pokemon && eligible(item, pokemon) &&
      fs.existsSync(path.join(dataDir, "frames", item.frame));
  });
const updates: { item: ScanItem; status: MaxStatus | null }[] = [];
for (let offset = 0; offset < items.length; offset += 16) {
  const group = items.slice(offset, offset + 16);
  const lines = await readLocalOcr(
    group.map((item) => path.join(dataDir, "frames", item.frame)),
  );
  for (let index = 0; index < group.length; index++)
    updates.push({
      item: group[index],
      status: await maxStatusFromScreenshot(
        path.join(dataDir, "frames", group[index].frame), lines[index],
      ),
    });
}
if (!dryRun) {
  transaction(() => {
    if (activeScan() || activeBatch())
      throw new Error("手機工作進行中，稍後再回填極巨化狀態");
    for (const { item, status } of updates) {
      if (status === null) continue;
      const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
      const current = get<ScanItem>("scan_items", item.id);
      if (!pokemon || !current || !eligible(current, pokemon)) continue;
      put("scan_items", item.id, { ...current, maxStatus: status });
      put("pokemon", pokemon.id, { ...pokemon, maxStatus: status, updatedAt: now() });
    }
  });
  reevaluate();
}
console.log(JSON.stringify({
  dryRun,
  checked: updates.length,
  none: updates.filter((row) => row.status === "none").length,
  dynamax: updates.filter((row) => row.status === "dynamax").length,
  gigantamax: updates.filter((row) => row.status === "gigantamax").length,
  unknown: updates.filter((row) => row.status === null).length,
}));
process.exit(0);
