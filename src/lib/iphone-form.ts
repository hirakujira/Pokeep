import { inferLevels } from "./evaluate";
import type { Fields, Snapshot, Species } from "./types";

/** Resolve a mistaken form only when CP, HP and IV fit exactly one sibling form. */
export function uniqueFormFromStats(fields: Fields, snapshot: Snapshot): {
  species: Species;
  level: number;
} | null {
  const observed = fields.speciesId && snapshot.species[fields.speciesId];
  if (
    !observed ||
    fields.shadow === null ||
    fields.cp === null ||
    fields.hp === null ||
    [fields.ivAtk, fields.ivDef, fields.ivSta].some((value) => value === null) ||
    inferLevels(observed, fields, snapshot).length
  )
    return null;
  const matching = Object.values(snapshot.species)
    .filter(
      (species) =>
        species.dex === observed.dex &&
        species.id !== observed.id &&
        species.id.endsWith("_shadow") === fields.shadow,
    )
    .flatMap((species) => {
      const levels = inferLevels(species, fields, snapshot);
      if (levels.length !== 1) return [];
      const level = levels[0];
      const index = Math.floor(level) - 1;
      const factor = fields.shadow ? 1.2 : fields.purified ? 0.9 : 1;
      if (
        (fields.powerUpDust !== null &&
          fields.powerUpDust !== Math.ceil(snapshot.powerups.dust[index] * factor)) ||
        (fields.powerUpCandy !== null &&
          fields.powerUpCandy !== Math.ceil(snapshot.powerups.candy[index] * factor))
      )
        return [];
      return [{ species, level }];
    });
  return matching.length === 1 ? matching[0] : null;
}

export function displayForm(species: Species): string | null {
  if (species.form === "(Therian)") return "靈獸形態";
  if (species.form === "(Incarnate)") return "化身形態";
  return species.form;
}
