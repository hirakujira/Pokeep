import type { Cost, Fields, Snapshot, Species } from "../types";

export function multiplier(snapshot: Snapshot, level: number): number {
  const low = Math.floor(level),
    value = snapshot.cpm[low - 1];
  return level === low
    ? value
    : Math.sqrt((value * value + snapshot.cpm[low] ** 2) / 2);
}
export function combatPower(
  s: Species,
  iv: number[],
  level: number,
  snapshot: Snapshot,
) {
  const c = multiplier(snapshot, level);
  return Math.max(
    10,
    Math.floor(
      ((s.atk + iv[0]) *
        Math.sqrt(s.def + iv[1]) *
        Math.sqrt(s.sta + iv[2]) *
        c *
        c) /
        10,
    ),
  );
}
export function hitPoints(
  s: Species,
  sta: number,
  level: number,
  snapshot: Snapshot,
) {
  return Math.max(10, Math.floor((s.sta + sta) * multiplier(snapshot, level)));
}
export function inferLevels(
  s: Species,
  f: Fields,
  snapshot: Snapshot,
): number[] {
  if (f.cp === null || f.ivAtk === null || f.ivDef === null || f.ivSta === null)
    return [];
  const result: number[] = [];
  for (let l = 1; l <= 50; l += 0.5)
    if (
      combatPower(s, [f.ivAtk, f.ivDef, f.ivSta], l, snapshot) === f.cp &&
      (f.hp === null || hitPoints(s, f.ivSta, l, snapshot) === f.hp)
    )
      result.push(l);
  return result;
}
export function powerCost(
  from: number,
  to: number,
  f: Fields,
  snapshot: Snapshot,
): Cost {
  let dust = 0,
    candy = 0,
    xl = 0;
  const factor = f.shadow ? 1.2 : f.purified ? 0.9 : 1;
  for (let level = from; level < to; level += 0.5) {
    const i = Math.floor(level) - 1;
    dust += Math.ceil((snapshot.powerups.dust[i] || 0) * factor);
    if (level < 40)
      candy += Math.ceil((snapshot.powerups.candy[i] || 0) * factor);
    else
      xl += Math.ceil(
        (snapshot.powerups.xl[Math.floor(level) - 40] || 0) * factor,
      );
  }
  return { dust, candy, xl, approximate: true };
}
function bestLevel(s: Species, iv: number[], cap: number, snapshot: Snapshot) {
  if (combatPower(s, iv, 1, snapshot) > cap) return 0;
  let lo = 0,
    hi = 98;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (combatPower(s, iv, 1 + mid / 2, snapshot) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return 1 + lo / 2;
}
function product(s: Species, iv: number[], level: number, snapshot: Snapshot) {
  const c = multiplier(snapshot, level);
  return (
    (s.atk + iv[0]) *
    (s.def + iv[1]) *
    c *
    c *
    hitPoints(s, iv[2], level, snapshot)
  );
}
// Rank tables depend only on species, league cap and game data. One collection
// needs thousands, more than an evicting cache keeps through a full evaluation,
// so they live as long as the snapshot.
let rankVersion = "";
const rankTables = new Map<string, Uint16Array>();
function ivScores(s: Species, cap: number, snapshot: Snapshot) {
  const scores = new Float64Array(4096);
  for (let a = 0; a < 16; a++)
    for (let d = 0; d < 16; d++)
      for (let h = 0; h < 16; h++) {
        const v = [a, d, h],
          l = bestLevel(s, v, cap, snapshot);
        scores[a * 256 + d * 16 + h] = l ? product(s, v, l, snapshot) : 0;
      }
  return scores;
}
function rankAmong(descending: Float64Array, score: number) {
  let lo = 0,
    hi = descending.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (descending[mid] > score + 1e-7) lo = mid + 1;
    else hi = mid;
  }
  return 1 + lo;
}
function rankTable(s: Species, cap: number, snapshot: Snapshot) {
  if (rankVersion !== snapshot.version) {
    rankTables.clear();
    rankVersion = snapshot.version;
  }
  const key = `${s.id}/${cap}`;
  let ranks = rankTables.get(key);
  if (!ranks) {
    const scores = ivScores(s, cap, snapshot);
    const descending = Float64Array.from(scores).sort().reverse();
    ranks = new Uint16Array(4096);
    for (let i = 0; i < 4096; i++) ranks[i] = rankAmong(descending, scores[i]);
    rankTables.set(key, ranks);
  }
  return ranks;
}
export function rankIV(
  s: Species,
  iv: number[],
  cap: number,
  snapshot: Snapshot,
) {
  const level = bestLevel(s, iv, cap, snapshot),
    score = level ? product(s, iv, level, snapshot) : 0;
  const rank =
    iv.length === 3 && iv.every((v) => Number.isInteger(v) && v >= 0 && v <= 15)
      ? rankTable(s, cap, snapshot)[iv[0] * 256 + iv[1] * 16 + iv[2]]
      : rankAmong(ivScores(s, cap, snapshot).sort().reverse(), score);
  return {
    rank,
    level,
    cp: level ? combatPower(s, iv, level, snapshot) : 0,
    percentile: (100 * (4096 - rank)) / 4095,
  };
}
