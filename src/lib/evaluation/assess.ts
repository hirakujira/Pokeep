import {
  effective,
  type Analysis,
  type Fields,
  type LeagueResult,
  type Pokemon,
  type RaidResult,
  type Snapshot,
  type Species,
} from "../types";
import { now } from "../store";
import { moveName } from "../move-names";
import { combatPower, inferLevels, powerCost, rankIV } from "./stats";
import { evolutionPaths, type EvolutionPath } from "./evolution";
import { cycleDps, raidBenchmarks } from "./raid";

export const localizedMoveAliases: Record<string, string> = { "逆鱗": "OUTRAGE" };
// These labels were used for the same chest-worn goggles in saved Charmander
// screenshots. Keep the original wording as evidence, but group their collection slot.
const charmanderGoggles = new Set([
  "泳鏡", "佩戴泳鏡", "胸前佩戴護目鏡", "胸前掛著護目鏡",
  "胸前佩戴黃色邊框護目鏡", "胸前掛著黃框太陽眼鏡",
  "胸前佩戴皮卡丘造型遮陽帽",
]);
export function collectionCostume(speciesId: string | null, costume: string | null) {
  return speciesId === "charmander" && costume && charmanderGoggles.has(costume)
    ? "胸前護目鏡"
    : costume;
}

function baseAnalysis(p: Pokemon, snapshot: Snapshot | null): Analysis {
  return {
    category: "review",
    reasons: [],
    warnings: [],
    collectionKeys: [],
    leagues: [],
    raids: [],
    currentLevels: [],
    actions: [],
    evolutionCandy: null,
    purification: null,
    comparedWith: [],
    snapshot: snapshot?.version || null,
    evaluatedAt: now(),
  };
}
function collectionKeys(f: Fields, s: Species) {
  const keys: string[] = [];
  const collectionForm = !s.form && (!f.form || f.form === "一般" || f.form === "normal")
    ? "normal" : f.form || s.form;
  const prefix = `${s.id.replace(/_shadow$/, "")}/${collectionForm}/${collectionCostume(f.speciesId, f.costume) || "none"}/${Boolean(f.shiny)}/${Boolean(f.shadow)}`;
  if (f.shiny) keys.push(`${prefix}/shiny`);
  if (f.costume) keys.push(`${prefix}/costume`);
  if (s.form) keys.push(`${prefix}/form`);
  if (s.tags.some((t) => ["legendary", "mythical", "ultrabeast"].includes(t)))
    keys.push(`${prefix}/rare`);
  const iv = [f.ivAtk, f.ivDef, f.ivSta];
  if (iv.every((v) => v === 15)) keys.push(`${prefix}/perfect`);
  if (iv.every((v) => v === 0)) keys.push(`${prefix}/zero`);
  return keys;
}
function missingMovesWarning(f: Fields, snapshot: Snapshot) {
  const movesWithPveData = new Set(Object.values(snapshot.moves).map((move) => move.name));
  const missingEquippedMoves = [f.fastMove, f.chargeMove, f.chargeMove2]
    .filter((move): move is string => Boolean(move))
    .filter((move) => !snapshot.moves[move] &&
      !snapshot.moves[localizedMoveAliases[move]] &&
      !movesWithPveData.has(move));
  return missingEquippedMoves.length
    ? `目前辨識的招式 ${missingEquippedMoves
        .map((move) => moveName(move, snapshot.moveNames))
        .join("、")} 在資料表中沒有團體戰（PvE）數值；這組實際招式的輸出無法估算`
    : null;
}
function leagueResults(
  path: EvolutionPath,
  values: number[],
  current: number | null,
  currentLevels: number[],
  f: Fields,
  snapshot: Snapshot,
) {
  const target = path.s;
  const leagues: LeagueResult[] = [];
  for (const cap of [1500, 2500, 10000]) {
    const ranking = snapshot.rankings[String(cap)] || [],
      index = ranking.findIndex((r) => r.speciesId === target.id),
      r = rankIV(target, values, cap, snapshot);
    if (!r.level) continue;
    const cost =
      current === null ? null : powerCost(current, r.level, f, snapshot);
    if (cost)
      cost.candy += f.purified ? Math.ceil(path.candy * 0.9) : path.candy;
    leagues.push({
      league: cap,
      speciesId: target.id,
      name: target.name,
      metaRank: index < 0 ? null : index + 1,
      ivRank: r.rank,
      percentile: r.percentile,
      level: r.level,
      cp: r.cp,
      cost,
      moves: index < 0 ? [] : ranking[index].moves,
      elite:
        index < 0
          ? []
          : ranking[index].moves.filter((m) => target.elite.includes(m)),
      eligible:
        currentLevels.length > 0 && Math.min(...currentLevels) <= r.level,
      buddyCp: combatPower(
        target,
        values,
        Math.min(51, r.level + 1),
        snapshot,
      ),
    });
  }
  return leagues;
}
function raidResults(
  path: EvolutionPath,
  values: number[],
  current: number | null,
  f: Fields,
  snapshot: Snapshot,
) {
  const target = path.s;
  const raids: RaidResult[] = [];
  for (const row of raidBenchmarks(snapshot).filter(
    (r) => r.speciesId === target.id,
  )) {
    const targets = [30, 35]
      .filter((l) => current === null || l >= current)
      .map((level) => {
        const cost =
          current === null ? null : powerCost(current, level, f, snapshot);
        if (cost)
          cost.candy += f.purified ? Math.ceil(path.candy * 0.9) : path.candy;
        return {
          level,
          cp: combatPower(target, values, level, snapshot),
          dps: cycleDps(
            target,
            values[0],
            level,
            row.fast,
            row.charge,
            snapshot,
          ),
          cost,
        };
      });
    raids.push({
      ...row,
      name: target.name,
      dps: cycleDps(target, values[0], 35, row.fast, row.charge, snapshot),
      elite: [row.fast, row.charge].filter((m) => target.elite.includes(m)),
      targets,
      condition: path.condition,
    });
  }
  return raids;
}
function purificationAdvice(
  a: Analysis,
  f: Fields,
  s: Species,
  values: number[],
  current: number | null,
  snapshot: Snapshot,
): NonNullable<Analysis["purification"]> {
  const purifiedIv = values.map((v) => Math.min(15, v + 2));
  const regular = snapshot.species[s.id.replace(/_shadow$/, "")];
  const purification = {
    iv: purifiedIv,
    cp:
      regular && current !== null
        ? combatPower(regular, purifiedIv, Math.max(25, current), snapshot)
        : null,
    verdict:
      "先保留暗影；淨化會改變輸出、IV 與聯盟 CP，不能只因滿 IV 就淨化。",
  };
  if (regular) {
    const possibilities = [
      regular,
      ...evolutionPaths(
        regular,
        { ...f, shadow: false, purified: true },
        snapshot,
      ).map((x) => x.s),
    ];
    const becomesUseful = possibilities.some((t) =>
      [1500, 2500].some((cap) => {
        const meta =
          snapshot.rankings[String(cap)]?.findIndex(
            (r) => r.speciesId === t.id,
          ) ?? -1;
        const rank = rankIV(t, purifiedIv, cap, snapshot);
        return (
          current !== null &&
          rank.level >= Math.max(25, current) &&
          meta >= 0 &&
          meta < 100 &&
          rank.rank <= 100
        );
      }),
    );
    const shadowUseful =
      a.raids.some((r) => r.rank <= 10) ||
      a.leagues.some(
        (l) =>
          l.metaRank !== null &&
          l.metaRank <= 100 &&
          l.ivRank <= 100 &&
          l.eligible,
      );
    if (becomesUseful && !shadowUseful)
      purification.verdict =
        "淨化後可能取得 PvP 價值；請先核對遷怒／報恩與進化條件，再決定淨化。";
  }
  return purification;
}
export function assess(p: Pokemon, snapshot: Snapshot | null): Analysis {
  const a = baseAnalysis(p, snapshot),
    f = effective(p),
    s = f.speciesId ? snapshot?.species[f.speciesId] : null;
  if (!snapshot || !s) {
    a.reasons.push("缺少物種或遊戲資料，無法可靠評估");
    return a;
  }
  if (f.shadow === null || f.shiny === null || f.purified === null)
    a.warnings.push("暗影、淨化或色違狀態未確認");
  a.collectionKeys = collectionKeys(f, s);
  const iv = [f.ivAtk, f.ivDef, f.ivSta];
  if (iv.some((v) => v === null) || f.cp === null) {
    a.reasons.push("尚缺 CP 或完整攻防體 IV");
    return a;
  }
  const values = iv as number[];
  a.currentLevels = inferLevels(s, f, snapshot);
  if (!a.currentLevels.length)
    a.warnings.push(
      "CP／HP 與 IV 無法推算目前等級，請確認形態、IV 或最佳夥伴加成",
    );
  const current = a.currentLevels.length === 1 ? a.currentLevels[0] : null;
  const paths = evolutionPaths(s, f, snapshot);
  if (paths.some((path) => path.condition))
    a.warnings.push("部分進化有額外條件，尚未確認符合前僅列潛力");
  for (const path of paths) {
    if (path.s.id === s.id) {
      const warning = missingMovesWarning(f, snapshot);
      if (warning) a.warnings.push(warning);
    }
    a.leagues.push(...leagueResults(path, values, current, a.currentLevels, f, snapshot));
    a.raids.push(...raidResults(path, values, current, f, snapshot));
  }
  if (f.shadow) {
    a.purification = purificationAdvice(a, f, s, values, current, snapshot);
    if (
      [f.chargeMove, f.chargeMove2].includes("FRUSTRATION") ||
      [f.chargeMove, f.chargeMove2].includes("遷怒")
    )
      a.actions.push(
        "遷怒需確認火箭隊活動是否允許移除；目前沒有活動即時資料。",
      );
  }
  if (current === null)
    a.warnings.push("目前等級未唯一確定，不顯示精確強化總成本");
  if (s.id.includes("eternatus"))
    a.warnings.push("此物種有專屬強化成本，標準成本估算不適用");
  a.warnings = [...new Set(a.warnings)];
  return a;
}
