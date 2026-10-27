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
const ivCache = new Map<string, number[]>();
export function rankIV(
  s: Species,
  iv: number[],
  cap: number,
  snapshot: Snapshot,
) {
  const key = `${snapshot.version}/${s.id}/${cap}`;
  let scores = ivCache.get(key);
  if (!scores) {
    scores = [];
    for (let a = 0; a < 16; a++)
      for (let d = 0; d < 16; d++)
        for (let h = 0; h < 16; h++) {
          const v = [a, d, h],
            l = bestLevel(s, v, cap, snapshot);
          scores.push(l ? product(s, v, l, snapshot) : 0);
        }
    scores.sort((a, b) => b - a);
    ivCache.set(key, scores);
    if (ivCache.size > 500) ivCache.delete(ivCache.keys().next().value!);
  }
  const level = bestLevel(s, iv, cap, snapshot),
    score = level ? product(s, iv, level, snapshot) : 0;
  const rank = 1 + scores.filter((v) => v > score + 1e-7).length;
  return {
    rank,
    level,
    cp: level ? combatPower(s, iv, level, snapshot) : 0,
    percentile: (100 * (4096 - rank)) / 4095,
  };
}
