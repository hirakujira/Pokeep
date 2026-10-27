import type { Snapshot, Species } from "../types";
import { multiplier } from "./stats";

export function cycleDps(
  s: Species,
  ivAtk: number,
  level: number,
  fast: string,
  charge: string,
  snapshot: Snapshot,
): number {
  const a = snapshot.moves[fast],
    b = snapshot.moves[charge];
  if (!a || !b || a.energy <= 0 || b.energy >= 0 || !a.duration || !b.duration)
    return 0;
  const atk = (s.atk + ivAtk) * multiplier(snapshot, level),
    shadow = s.tags.includes("shadow") ? 1.2 : 1;
  const damage = (move: typeof a) =>
    Math.floor(
      ((0.5 * move.power * atk) / 150) *
        (s.types.includes(move.type) ? 1.2 : 1) *
        shadow,
    ) + 1;
  const n = Math.ceil(-b.energy / a.energy);
  return (n * damage(a) + damage(b)) / (n * a.duration + b.duration);
}
type RaidBase = {
  speciesId: string;
  type: string;
  fast: string;
  charge: string;
  dps: number;
  rank: number;
};
const raidCache = new Map<string, RaidBase[]>();
export function raidBenchmarks(snapshot: Snapshot) {
  if (raidCache.has(snapshot.version)) return raidCache.get(snapshot.version)!;
  const rows: RaidBase[] = [];
  for (const s of Object.values(snapshot.species))
    for (const type of s.types) {
      let best: RaidBase | null = null;
      for (const a of s.fast)
        for (const b of s.charged) {
          if (
            snapshot.moves[a]?.type !== type ||
            snapshot.moves[b]?.type !== type ||
            b === "FRUSTRATION" ||
            b === "RETURN"
          )
            continue;
          const dps = cycleDps(s, 15, 35, a, b, snapshot);
          if (dps && (!best || dps > best.dps))
            best = { speciesId: s.id, type, fast: a, charge: b, dps, rank: 0 };
        }
      if (best) rows.push(best);
    }
  for (const type of new Set(rows.map((r) => r.type)))
    rows
      .filter((r) => r.type === type)
      .sort((a, b) => b.dps - a.dps)
      .forEach((r, i) => {
        r.rank = i + 1;
      });
  raidCache.clear();
  raidCache.set(snapshot.version, rows);
  return rows;
}
