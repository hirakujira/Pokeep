import { analyzeOne } from "../src/lib/iphone-scan";
import { scanItems, updateScan } from "../src/lib/iphone-data";
import { reevaluate } from "../src/lib/evaluate";
import { get, getSnapshot } from "../src/lib/store";
import type { Scan } from "../src/lib/iphone-types";
import type { Pokemon } from "../src/lib/types";

const scanId = process.argv[2];
if (!scanId) throw new Error("請提供已完成的掃描 ID");
const scan = get<Scan>("scans", scanId);
if (scan?.status !== "completed") throw new Error("只能重核對已完成的掃描");
const snapshot = getSnapshot();
if (!snapshot || !Object.values(snapshot.species).some((s) => s.genderless))
  throw new Error("請先用已保存的 Game Master 更新物種資料");

const targets = scanItems(scanId).filter((item) => {
  const record = item.pokemonId ? get<Pokemon>("pokemon", item.pokemonId) : null;
  return (
    record &&
    !record.verified &&
    record.fields.gender === null &&
    record.fields.speciesId &&
    snapshot.species[record.fields.speciesId]?.genderless
  );
});
let processed = 0;
let failures = 0;
const concurrency = 1;
for (let offset = 0; offset < targets.length; offset += concurrency) {
  await Promise.all(
    targets.slice(offset, offset + concurrency).map(async (item) => {
      try {
        await analyzeOne(scanId, item, undefined, true);
      } catch (error) {
        failures++;
        console.error(
          `第 ${item.position + 1} 隻重核對失敗: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      processed++;
    }),
  );
  if (processed % 10 === 0 || processed === targets.length)
    console.log(`已重核對 ${processed} / ${targets.length}`);
}
const review = scanItems(scanId).filter((item) => {
  const record = item.pokemonId ? get<Pokemon>("pokemon", item.pokemonId) : null;
  return record && !record.verified;
}).length;
updateScan(scanId, { review });
reevaluate();
console.log(JSON.stringify({ targets: targets.length, failures, review }));
