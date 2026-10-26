import fs from "node:fs";
import path from "node:path";
import { reevaluate } from "../src/lib/evaluate";
import { activeBatch, activeScan } from "../src/lib/iphone-data";
import type { ScanItem } from "../src/lib/iphone-types";
import { readLocalOcr } from "../src/lib/local-ocr";
import { maxStatusFromOcr, type MaxStatus } from "../src/lib/max-status";
import { all, dataDir, get, put, transaction } from "../src/lib/store";
import type { Pokemon } from "../src/lib/types";

if (activeScan() || activeBatch())
  throw new Error("手機工作進行中，稍後再回填極巨化狀態");
const items = all<ScanItem>("scan_items")
  .filter((item) => item.pokemonId && item.frame && item.maxStatus === undefined)
  .filter((item) => {
    const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
    return pokemon && pokemon.maxStatus === undefined &&
      fs.existsSync(path.join(dataDir, "frames", item.frame));
  });
const updates: { item: ScanItem; status: MaxStatus | null }[] = [];
for (let offset = 0; offset < items.length; offset += 16) {
  const group = items.slice(offset, offset + 16);
  const lines = await readLocalOcr(
    group.map((item) => path.join(dataDir, "frames", item.frame)),
  );
  for (let index = 0; index < group.length; index++)
    updates.push({ item: group[index], status: maxStatusFromOcr(lines[index]) });
}
transaction(() => {
  if (activeScan() || activeBatch())
    throw new Error("手機工作進行中，稍後再回填極巨化狀態");
  for (const { item, status } of updates) {
    const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
    if (!pokemon || pokemon.maxStatus !== undefined) continue;
    put("scan_items", item.id, { ...item, maxStatus: status });
    put("pokemon", pokemon.id, { ...pokemon, maxStatus: status });
  }
});
reevaluate();
console.log(JSON.stringify({
  checked: updates.length,
  none: updates.filter((row) => row.status === "none").length,
  dynamax: updates.filter((row) => row.status === "dynamax").length,
  gigantamax: updates.filter((row) => row.status === "gigantamax").length,
  unknown: updates.filter((row) => row.status === null).length,
}));
process.exit(0);
