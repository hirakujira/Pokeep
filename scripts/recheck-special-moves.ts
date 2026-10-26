import { analyzeOne } from "../src/lib/iphone-scan";
import { scanItems, updateScan } from "../src/lib/iphone-data";
import { reevaluate } from "../src/lib/evaluate";
import { specialStateFromMoves } from "../src/lib/iphone-safety";
import { get } from "../src/lib/store";
import type { Scan } from "../src/lib/iphone-types";
import type { Pokemon } from "../src/lib/types";

const scanId = process.argv[2];
if (!scanId) throw new Error("請提供已完成的掃描 ID");
const scan = get<Scan>("scans", scanId);
if (scan?.status !== "completed") throw new Error("只能重核對已完成的掃描");
const targets = scanItems(scanId).filter((item) => {
  const record = item.pokemonId ? get<Pokemon>("pokemon", item.pokemonId) : null;
  if (!record || record.verified || record.verification === "human") return false;
  const moveState = specialStateFromMoves(record.fields);
  return Boolean(
    moveState.signal &&
      !moveState.conflict &&
      (record.fields.shadow === null || record.fields.purified === null),
  );
});
let failures = 0;
for (const item of targets)
  try {
    await analyzeOne(scanId, item, undefined, true);
  } catch (error) {
    failures++;
    console.error(
      `第 ${item.position + 1} 隻重核對失敗: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
const review = scanItems(scanId).filter((item) => {
  const record = item.pokemonId ? get<Pokemon>("pokemon", item.pokemonId) : null;
  return record && !record.verified;
}).length;
updateScan(scanId, { review });
reevaluate();
console.log(JSON.stringify({ targets: targets.length, failures, review }));
