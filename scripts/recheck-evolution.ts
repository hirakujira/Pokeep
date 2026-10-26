import fs from "node:fs";
import path from "node:path";
import { evolutionSilhouette } from "../src/lib/evolution-silhouette";
import { reevaluate } from "../src/lib/evaluate";
import { readLocalOcr } from "../src/lib/local-ocr";
import { activeBatch, activeScan } from "../src/lib/iphone-data";
import { all, dataDir, get, getSnapshot, put, transaction } from "../src/lib/store";
import type { Scan, ScanItem } from "../src/lib/iphone-types";
import { effective, type Pokemon } from "../src/lib/types";

const scan = all<Scan>("scans")
  .filter((row) => row.scope === "all" && row.status === "completed")
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
if (!scan) throw new Error("沒有已完成的整盒掃描，無法回填進化剪影");
const snapshot = getSnapshot();
const speciesFilter = process.argv.find((arg) => arg.startsWith("--species="))?.slice(10);
if (speciesFilter && !/^[a-z0-9_]+$/.test(speciesFilter))
  throw new Error("物種 ID 格式無效");
const recheckAll = process.argv.includes("--recheck-all");
const recheckUnknown = process.argv.includes("--recheck-unknown");
if (recheckAll && !speciesFilter)
  throw new Error("重新檢查所有結果時必須指定 --species=物種ID");
const items = all<ScanItem>("scan_items")
  .filter((item) => item.scanId === scan.id && item.pokemonId && item.movesFrame)
  .filter((item) =>
    recheckAll ? true : recheckUnknown
      ? item.evolutionSilhouette == null
      : item.evolutionSilhouette === undefined,
  )
  .filter((item) => {
    if (!recheckUnknown || recheckAll) return true;
    const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
    const speciesId = pokemon && effective(pokemon).speciesId;
    return Boolean(speciesId && snapshot?.species[speciesId]?.evolutions.length);
  })
  .filter((item) => {
    if (speciesFilter) {
      const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
      if (!pokemon || effective(pokemon).speciesId !== speciesFilter) return false;
    }
    if (!process.argv.includes("--multi-branch-only")) return true;
    const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
    const speciesId = pokemon && effective(pokemon).speciesId;
    return Boolean(speciesId && snapshot?.species[speciesId]?.evolutions.length &&
      snapshot.species[speciesId].evolutions.length > 1);
  });
let silhouettes = 0;
let coloured = 0;
let uncertain = 0;
const updates: { item: ScanItem; result: boolean | null }[] = [];
for (let offset = 0; offset < items.length; offset += 16) {
  const group = items.slice(offset, offset + 16).filter((item) =>
    fs.existsSync(path.join(dataDir, "frames", item.movesFrame!)),
  );
  if (!group.length) continue;
  const files = group.map((item) => path.join(dataDir, "frames", item.movesFrame!));
  const lines = await readLocalOcr(files);
  for (let index = 0; index < group.length; index++) {
    const item = group[index];
    const result = await evolutionSilhouette(files[index], lines[index]);
    if (result === true) silhouettes++;
    else if (result === false) coloured++;
    else uncertain++;
    updates.push({ item, result });
  }
}
transaction(() => {
  if (activeScan() || activeBatch())
    throw new Error("手機工作進行中，稍後再回填進化剪影");
  for (const { item, result } of updates) {
    put("scan_items", item.id, { ...item, evolutionSilhouette: result });
    const pokemon = get<Pokemon>("pokemon", item.pokemonId!);
    if (pokemon)
      put("pokemon", pokemon.id, { ...pokemon, evolutionSilhouette: result });
  }
});
reevaluate();
console.log(
  JSON.stringify({ scanned: items.length, silhouettes, coloured, uncertain }),
);
process.exit(0);
