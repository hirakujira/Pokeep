import type {
  Fields,
  LeagueResult,
  MoveTrainingAdvice,
  MoveTrainingStep,
  RaidResult,
  Snapshot,
  Species,
} from "../types";
import { localizedMoveAliases, moveName } from "../move-names";
import { typeName } from "../type-names";
import { cycleDps } from "./raid";

export type CombatPick = { raid?: RaidResult; league?: LeagueResult };

const leagueNames: Record<number, string> = {
  1500: "超級聯盟",
  2500: "高級聯盟",
  10000: "大師聯盟",
};

export function moveId(value: string, snapshot: Snapshot | null) {
  return (
    snapshot?.moves[value]?.id ||
    Object.values(snapshot?.moves || {}).find(
      (m) => m.name === value || moveName(m.id, snapshot?.moveNames) === value,
    )?.id ||
    localizedMoveAliases[value] ||
    value
  );
}

// PvPoke expands Hidden Power into one entry per type, but the game rolls it
// as a single move and only then picks the type.
const poolKey = (m: string) => (m.startsWith("HIDDEN_POWER_") ? "HIDDEN_POWER" : m);

// PvPoke lists elite moves inside fast/chargedMoves too. Ordinary TMs draw
// uniformly from the non-elite pool minus the moves already known.
function step(
  kind: "fast" | "charged",
  s: Species,
  known: string[],
  from: string | null,
  to: string,
): MoveTrainingStep {
  const learnable = kind === "fast" ? s.fast : s.charged;
  const elite = s.elite.includes(to);
  const knownKeys = known.map(poolKey);
  const pool = new Set(
    learnable
      .filter((m) => !s.elite.includes(m))
      .map(poolKey)
      .filter((key) => !knownKeys.includes(key)),
  );
  const typeOdds = poolKey(to) === "HIDDEN_POWER"
    ? learnable.filter((m) => poolKey(m) === "HIDDEN_POWER").length
    : 1;
  const notes: string[] = [];
  let blocked = false;
  if (!learnable.includes(to)) {
    blocked = true;
    notes.push("此招式不在學習器招式池，請核對取得方式");
  }
  if (from === "FRUSTRATION") {
    blocked = true;
    notes.push("遷怒平時無法用學習器移除，需等允許移除的火箭隊活動");
  } else if (from === "RETURN") notes.push("報恩換掉後無法再取回");
  else if (from === null)
    notes.push(
      elite
        ? "先解鎖第二特殊招式，再對新招式使用"
        : "先解鎖第二特殊招式；解鎖也是隨機抽招，抽中就不必用學習器",
    );
  return {
    tm: elite ? (kind === "fast" ? "eliteFast" : "eliteCharged") : kind,
    from,
    to,
    odds: elite ? 1 : Math.max(1, pool.size) * typeOdds,
    blocked,
    note: notes.join("；") || null,
  };
}

function trainingSteps(s: Species, fast: string, charged: string[], target: string[]) {
  const [targetFast, ...targetCharged] = target;
  const steps: MoveTrainingStep[] = [];
  if (fast !== targetFast) steps.push(step("fast", s, [fast], fast, targetFast));
  const known = [...charged];
  for (const to of targetCharged.filter((m) => !charged.includes(m))) {
    const spare = known.filter((m) => !targetCharged.includes(m));
    const from =
      spare.find((m) => m !== "FRUSTRATION") ??
      (known.length < 2 ? null : spare[0] ?? null);
    steps.push(step("charged", s, known, from, to));
    if (from === null) known.push(to);
    else known[known.indexOf(from)] = to;
  }
  return steps;
}

export function moveTraining(
  f: Fields,
  picks: CombatPick[],
  snapshot: Snapshot,
): MoveTrainingAdvice[] {
  const s = f.speciesId ? snapshot.species[f.speciesId] : null;
  if (!s) return [];
  const fast = f.fastMove ? moveId(f.fastMove, snapshot) : null;
  const charged = [f.chargeMove, f.chargeMove2]
    .filter((m): m is string => Boolean(m))
    .map((m) => moveId(m, snapshot));
  const advise = (
    purpose: MoveTrainingAdvice["purpose"],
    label: string,
    rank: number,
    target: { speciesId: string; name: string },
    moves: string[],
    raid?: RaidResult,
  ): MoveTrainingAdvice => {
    const base = { purpose, label, rank, ...target, steps: [], dps: null };
    if (target.speciesId !== s.id) return { ...base, status: "evolveFirst" };
    if (!fast || !charged.length) return { ...base, status: "incomplete" };
    const steps = trainingSteps(s, fast, charged, moves);
    const current = raid
      ? Math.max(0, ...charged.map((c) => cycleDps(s, f.ivAtk ?? 0, 35, fast, c, snapshot)))
      : 0;
    return {
      ...base,
      status: steps.length ? "train" : "ready",
      steps,
      dps: raid && current > 0 ? { current, best: raid.dps } : null,
    };
  };
  return picks.flatMap(({ raid, league }) => [
    ...(raid
      ? [advise(
          "raid",
          `團體戰 ${typeName(raid.type)}屬性 #${raid.rank}`,
          raid.rank,
          { speciesId: raid.speciesId, name: raid.name },
          [raid.fast, raid.charge],
          raid,
        )]
      : []),
    ...(league && league.metaRank !== null && league.moves.length
      ? [advise(
          "pvp",
          `${leagueNames[league.league]} 環境 #${league.metaRank}`,
          league.metaRank,
          { speciesId: league.speciesId, name: league.name },
          league.moves,
        )]
      : []),
  ]);
}
