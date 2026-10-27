import type { Fields, Snapshot, Species } from "../types";

export type EvolutionPath = { s: Species; candy: number; condition: string | null };
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
        walk(next, candy + e.candy, [
          ...conditions,
          ...(e.condition ? [e.condition] : []),
        ]);
    }
  }
  walk(s, 0, []);
  return paths;
}
