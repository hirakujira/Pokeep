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
import { resolveSpecies } from "./game-data";
import type { Scan, ScanItem } from "./iphone-types";

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

/** Re-resolve a species ID the current snapshot does not know, e.g. one guessed before a resolver fix. */
function repairUnknownSpecies(p: Pokemon, snapshot: Snapshot | null): Pokemon {
  const f = p.fields;
  if (!snapshot || !f.speciesId || snapshot.species[f.speciesId]) return p;
  const species = resolveSpecies(snapshot, f.name, f.form, f.shadow, f.speciesId, f);
  return { ...p, fields: { ...f, speciesId: species?.id ?? null }, updatedAt: now() };
}
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
/** The newest full box scan plus the completed latest-catch scans started after it. */
export function completeBoxIds() {
  const scans = all<Scan>("scans");
  const full = scans
    .filter((scan) => scan.scope === "all" && scan.status === "completed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!full?.scanned) return undefined;
  const items = all<ScanItem>("scan_items");
  const ids = (scan: Scan) =>
    items.filter((item) => item.scanId === scan.id && item.pokemonId)
      .map((item) => item.pokemonId!);
  const fullIds = ids(full);
  if (fullIds.length !== full.scanned) return undefined;
  const later = scans.filter(
    (scan) => scan.scope === "latest" && scan.createdAt > full.createdAt,
  );
  // An unfinished latest-catch scan that saved Pokémon may have left older catches unscanned.
  if (later.some((scan) => scan.status !== "completed" && ids(scan).length))
    return new Set(fullIds);
  return new Set([
    ...fullIds,
    ...later.filter((scan) => scan.status === "completed").flatMap(ids),
  ]);
}
export function reevaluate() {
  const snapshot = getSnapshot();
  const result = evaluateCollection(
    listPokemon().map((p) =>
      reconcileReviewedEvidence(repairUnknownSpecies(p, snapshot), snapshot)),
    snapshot,
    getSettings(),
    completeBoxIds(),
  );
  transaction(() => {
    for (const p of result) put("pokemon", p.id, p);
  });
  return result;
}
