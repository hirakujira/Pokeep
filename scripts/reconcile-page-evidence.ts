import fs from "node:fs";
import path from "node:path";
import { inferLevels, reevaluate } from "../src/lib/evaluate";
import { scanItems, updateScan } from "../src/lib/iphone-data";
import {
  automaticVerification,
  blockingEvidenceIssues,
  reconcilePageIssues,
} from "../src/lib/iphone-safety";
import { dataDir, get, getSnapshot, now, put, transaction } from "../src/lib/store";
import type { Scan } from "../src/lib/iphone-types";
import type { Observation, Pokemon } from "../src/lib/types";

const scanId = process.argv[2];
if (!scanId) throw new Error("請指定已完成的掃描 ID");
const scan = get<Scan>("scans", scanId);
if (!scan || scan.status !== "completed")
  throw new Error("只能修復已完成掃描的既有截圖");
const snapshot = getSnapshot();
if (!snapshot) throw new Error("缺少遊戲資料快照");

let corrected = 0;
let verified = 0;
for (const item of scanItems(scanId)) {
  if (!item.pokemonId || !item.movesFrame || !item.appraisalFrame) continue;
  const pokemon = get<Pokemon>("pokemon", item.pokemonId);
  if (
    !pokemon ||
    pokemon.jobId !== scanId ||
    pokemon.verification === "human" ||
    Object.keys(pokemon.overrides).length ||
    pokemon.candidates.length
  )
    continue;
  const observations = [0, 1, 2].map((index) =>
    get<Observation>("observations", `${scanId}-${item.position}-${index}`),
  );
  if (
    observations.some((row) => !row || row.segment !== item.id) ||
    observations[0]!.frame !== item.frame ||
    observations[1]!.frame !== item.movesFrame ||
    observations[2]!.frame !== item.appraisalFrame ||
    [item.frame, item.movesFrame, item.appraisalFrame].some(
      (frame) => !fs.existsSync(path.join(dataDir, "frames", frame)),
    )
  )
    continue;
  const top = observations[0]!.fields;
  const appraisal = observations[2]!.fields;
  const species = pokemon.fields.speciesId
    ? snapshot.species[pokemon.fields.speciesId]
    : null;
  const issues = reconcilePageIssues({
    issues: pokemon.issues,
    fields: pokemon.fields,
    top,
    appraisal,
    speciesName: species?.name,
    detailClear: item.protectionClear === true,
    costumeAbsentClear: item.protectionClear === true,
  });
  if (issues.length === pokemon.issues.length) continue;
  const canVerify =
    !pokemon.verified &&
    automaticVerification({
      fields: pokemon.fields,
      top,
      appraisal,
      measuredIV: item.measuredIV || null,
      levels: species ? inferLevels(species, pokemon.fields, snapshot) : [],
      clear: item.protectionClear === true,
      issues: blockingEvidenceIssues(issues, pokemon.fields),
      costumeAbsentClear: item.protectionClear === true,
      warningVisible: false,
    });
  transaction(() => {
    put("pokemon", pokemon.id, {
      ...pokemon,
      issues,
      verified: pokemon.verified || canVerify,
      verification: canVerify ? "automatic" : pokemon.verification,
      updatedAt: now(),
    });
    put("scan_items", item.id, { ...item, issues });
  });
  corrected++;
  if (canVerify) verified++;
  console.log(`${item.position + 1}: 修正 ${pokemon.issues.length - issues.length} 項註記${canVerify ? "；通過自動核對" : ""}`);
}
if (corrected) {
  const review = scanItems(scanId).filter((item) => {
    const pokemon = item.pokemonId && get<Pokemon>("pokemon", item.pokemonId);
    return pokemon && !pokemon.verified;
  }).length;
  updateScan(scanId, { review });
  reevaluate();
}
console.log(`完成：修正 ${corrected} 隻，自動核對 ${verified} 隻`);
