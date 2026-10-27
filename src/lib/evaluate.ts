import { effective, type Pokemon, type Snapshot } from "./types";
import {
  all,
  getSettings,
  getSnapshot,
  listPokemon,
  now,
  put,
  transaction,
} from "./store";
import { evaluateCollection } from "./evaluation/collection";
import type { Scan, ScanItem } from "./iphone-types";

export { collectionCostume } from "./evaluation/assess";
export { verificationEvidenceGaps } from "./evaluation/review";
export {
  multiplier,
  combatPower,
  hitPoints,
  inferLevels,
  powerCost,
  rankIV,
} from "./evaluation/stats";
export { evolutionPaths } from "./evaluation/evolution";
export { cycleDps } from "./evaluation/raid";
export { evaluateCollection };

export function reconcileReviewedEvidence(p: Pokemon, snapshot: Snapshot | null): Pokemon {
  if (p.verification !== "human" || !p.verified || !snapshot) return p;
  const speciesId = effective(p).speciesId;
  const species = speciesId ? snapshot.species[speciesId] : null;
  if (!species) return p;
  const issues = p.issues.filter((issue) =>
    issue !== "物種／形態無法唯一對應，請人工核對",
  );
  const inferGender = species.genderless === true && p.fields.gender === null &&
    !Object.hasOwn(p.overrides, "gender");
  if (issues.length === p.issues.length && !inferGender) return p;
  return {
    ...p,
    fields: inferGender ? { ...p.fields, gender: "genderless" } : p.fields,
    issues,
    updatedAt: now(),
  };
}
export function reevaluate() {
  const latestFullScan = all<Scan>("scans")
    .filter((scan) => scan.scope === "all" && scan.status === "completed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const fullItems = latestFullScan
    ? all<ScanItem>("scan_items").filter(
        (item) => item.scanId === latestFullScan.id && item.pokemonId,
      )
    : [];
  const completeBoxIds =
    latestFullScan &&
    fullItems.length === latestFullScan.scanned &&
    latestFullScan.scanned > 0
      ? new Set(fullItems.map((item) => item.pokemonId!))
      : undefined;
  const snapshot = getSnapshot();
  const result = evaluateCollection(
    listPokemon().map((p) => reconcileReviewedEvidence(p, snapshot)),
    snapshot,
    getSettings(),
    completeBoxIds,
  );
  transaction(() => {
    for (const p of result) put("pokemon", p.id, p);
  });
  return result;
}
