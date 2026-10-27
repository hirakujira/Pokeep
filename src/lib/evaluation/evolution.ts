import type { Fields, Snapshot, Species } from "../types";

export type EvolutionPath = { s: Species; candy: number; condition: string | null };
/** Candy one evolution costs; a purified Pokémon pays the Game Master's purified price, or about 10% less when none is listed. */
export function stepCandy(
  e: Pick<Species["evolutions"][number], "candy" | "candyPurified">,
  purified: boolean | null,
) {
  return purified ? e.candyPurified ?? Math.ceil(e.candy * 0.9) : e.candy;
}
export function evolutionPaths(
  s: Species,
  f: Fields,
  snapshot: Snapshot,
): EvolutionPath[] {
  const paths: EvolutionPath[] = [],
    seen = new Set<string>();
  function walk(current: Species, candy: number, conditions: string[]) {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    paths.push({ s: current, candy, condition: conditions.join("；") || null });
    // A visible costume is not evidence that its uncostumed evolution is available.
    if (f.costume) return;
    for (const e of current.evolutions) {
      if (e.gender && f.gender && e.gender !== f.gender) continue;
      const next = snapshot.species[e.id];
      if (next)
        walk(next, candy + stepCandy(e, f.purified), [
          ...conditions,
          ...(e.condition ? [e.condition] : []),
        ]);
    }
  }
  walk(s, 0, []);
  return paths;
}
