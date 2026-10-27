import {
  effective,
  type Fields,
  type LeagueResult,
  type Pokemon,
  type RaidResult,
  type Settings,
  type Snapshot,
  type Species,
} from "../types";
import { specialStateFromMoves } from "../iphone-safety";
import { typeName } from "../type-names";
import { assess } from "./assess";
import {
  categorize,
  type EvolutionChoice,
  type EvolutionOption,
  type LineChoice,
  type Pick,
} from "./categorize";

type AddPick = (p: Pokemon, reason: string, peers: Pokemon[]) => void;

function quality(p: Pokemon) {
  const f = effective(p);
  return (
    (p.locked ? 10000 : 0) +
    (p.verified ? 1000 : 0) +
    (f.ivAtk || 0) +
    (f.ivDef || 0) +
    (f.ivSta || 0) +
    (f.cp || 0) / 10000
  );
}
function pickCollectibles(living: Pokemon[], settings: Settings, add: AddPick) {
  const collectibles = new Map<string, Pokemon[]>();
  for (const p of living)
    for (const key of p.analysis!.collectionKeys)
      collectibles.set(key, [...(collectibles.get(key) || []), p]);
  for (const peers of collectibles.values())
    peers
      .sort((a, b) => quality(b) - quality(a))
      .slice(0, settings.rareRepresentatives)
      .forEach((p) => add(p, "保留此特殊收藏的代表個體", peers));
}
function pickHighIv(confirmed: Pokemon[], add: AddPick) {
  const highIvGroups = new Map<string, Pokemon[]>();
  for (const p of confirmed) {
    const f = effective(p);
    if (
      !f.speciesId || f.ivAtk === null || f.ivDef === null ||
      f.ivSta === null || f.ivAtk + f.ivDef + f.ivSta < 40 ||
      f.shadow === null || f.purified === null || f.shiny === null ||
      f.costume !== null || p.maxStatus == null ||
      specialStateFromMoves(f).conflict
    ) continue;
    const key = `${f.speciesId}/${f.form || "normal"}/${f.shadow}`;
    highIvGroups.set(key, [...(highIvGroups.get(key) || []), p]);
  }
  const highIvPeers = new Map<string, string>();
  for (const peers of highIvGroups.values()) {
    peers.sort((left, right) => {
      const a = effective(left), b = effective(right);
      const total = (f: Fields) => (f.ivAtk ?? 0) + (f.ivDef ?? 0) + (f.ivSta ?? 0);
      return total(b) - total(a) ||
        (b.ivAtk ?? 0) - (a.ivAtk ?? 0) ||
        Math.min(...right.analysis!.currentLevels) -
          Math.min(...left.analysis!.currentLevels) ||
        (b.cp ?? 0) - (a.cp ?? 0) ||
        left.id.localeCompare(right.id);
    });
    const winner = peers[0];
    const f = effective(winner);
    const total = f.ivAtk! + f.ivDef! + f.ivSta!;
    add(winner, `IV ${total}/45；保留此物種已核對個體中最佳的高 IV 收藏代表`, peers);
    for (const peer of peers.slice(1)) highIvPeers.set(peer.id, winner.id);
  }
  return highIvPeers;
}
function pickPvp(confirmed: Pokemon[], settings: Settings, add: AddPick) {
  const pvp = new Map<string, { p: Pokemon; l: LeagueResult }[]>();
  for (const p of confirmed)
    for (const l of p.analysis!.leagues)
      if (
        l.eligible &&
        l.metaRank !== null &&
        l.metaRank <= settings.metaCutoff &&
        (l.league === 10000 || l.ivRank <= settings.ivCutoff)
      ) {
        const key = `${l.speciesId}/${l.league}`;
        pvp.set(key, [...(pvp.get(key) || []), { p, l }]);
      }
  for (const rows of pvp.values()) {
    rows.sort(
      (a, b) =>
        Number(b.p.locked) - Number(a.p.locked) ||
        a.l.ivRank - b.l.ivRank ||
        (a.l.cost?.dust ?? Infinity) - (b.l.cost?.dust ?? Infinity),
    );
    const { p, l } = rows[0];
    add(
      p,
      `${l.name} 入選 PvP ${l.league === 10000 ? "大師" : l.league === 1500 ? "超級" : "高級"}聯盟：環境排名 #${l.metaRank}／IV 排名 #${l.ivRank}`,
      rows.map((r) => r.p),
    );
  }
}
function pickRaids(confirmed: Pokemon[], settings: Settings, add: AddPick) {
  const raids = new Map<string, { p: Pokemon; r: RaidResult }[]>();
  for (const p of confirmed)
    for (const r of p.analysis!.raids.filter((r) => r.rank <= 10)) {
      const entries = raids.get(r.type) || [],
        previous = entries.find((e) => e.p.id === p.id);
      if (!previous || previous.r.dps < r.dps)
        raids.set(r.type, [
          ...entries.filter((e) => e.p.id !== p.id),
          { p, r },
        ]);
    }
  for (const rows of raids.values()) {
    rows.sort(
      (a, b) =>
        b.r.dps - a.r.dps ||
        (a.r.targets[0]?.cost?.dust ?? Infinity) -
          (b.r.targets[0]?.cost?.dust ?? Infinity),
    );
    for (const { p, r } of rows.slice(0, settings.raidSlots))
      add(
        p,
        `${r.name} 入選團體戰 ${typeName(r.type)}屬性隊伍：基準物種輸出排名 #${r.rank}`,
        rows.map((r) => r.p),
      );
  }
}
function groupEvolutionCandidates(living: Pokemon[], snapshot: Snapshot | null) {
  const groups = new Map<string, { p: Pokemon; options: EvolutionOption[] }[]>();
  const needsReview = new Set<string>();
  for (const p of living) {
    const f = effective(p),
      a = p.analysis!;
    if (
      p.locked || f.shiny === true || !p.verified || p.candidates.length ||
      specialStateFromMoves(f).conflict || !snapshot || !f.speciesId ||
      !a.currentLevels.length ||
      [f.cp, f.ivAtk, f.ivDef, f.ivSta, f.shadow, f.purified, f.shiny].some(
        (value) => value === null,
      ) ||
      p.evolutionSilhouette !== true || f.costume !== null
    ) continue;
    const evolutions = snapshot.species[f.speciesId]?.evolutions.filter(
      (evolution) => !evolution.gender || evolution.gender === f.gender,
    ) || [];
    const options = evolutions.flatMap((evolution) => {
      const target = snapshot.species[evolution.id];
      return target ? [{ target, candy: evolution.candy, condition: evolution.condition }] : [];
    });
    if (!options.length || options.length !== evolutions.length) {
      needsReview.add(p.id);
      continue;
    }
    const missing = options.filter(({ target }) =>
      !living.some((peer) =>
        effective(peer).speciesId === target.id,
      ),
    );
    if (missing.length !== options.length) {
      if (missing.length) needsReview.add(p.id);
      continue;
    }
    // The screenshot proves at least one branch is unregistered, but cannot
    // pair each silhouette with a named branch. Only infer multi-branch
    // evolution automatically when none of its immediate forms is in the
    // imported, still-owned collection. This recommendation does not authorize
    // a transfer, even if the phone scan stopped before covering the whole box.
    const key = `${f.speciesId}/${options.map(({ target }) => target.id).sort().join(",")}`;
    groups.set(key, [
      ...(groups.get(key) || []),
      { p, options },
    ]);
  }
  return { groups, needsReview };
}
function evolutionRank(p: Pokemon, target: Species, settings: Settings) {
  const a = p.analysis!, f = effective(p);
  const pvp = a.leagues
    .filter(
      (league) =>
        league.speciesId === target.id && league.eligible &&
        league.metaRank !== null && league.metaRank <= settings.metaCutoff &&
        league.ivRank <= settings.ivCutoff,
    )
    .sort((left, right) => left.ivRank - right.ivRank)[0];
  const raidDps = Math.max(
    0,
    ...a.raids
      .filter((raid) => raid.speciesId === target.id && raid.rank <= 10)
      .map((raid) => raid.dps),
  );
  return [
    pvp ? 1 : 0,
    pvp ? -pvp.ivRank : 0,
    raidDps,
    (f.ivAtk || 0) + (f.ivDef || 0) + (f.ivSta || 0),
    f.ivAtk || 0,
    Math.min(...a.currentLevels),
    f.cp || 0,
  ];
}
function compareRank(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}
function chooseEvolutions(
  living: Pokemon[],
  snapshot: Snapshot | null,
  settings: Settings,
): EvolutionChoice {
  const { groups, needsReview } = groupEvolutionCandidates(living, snapshot);
  const winners = new Map<string, EvolutionOption[]>();
  const peers = new Map<string, string>();
  const bestEvolutionRank = (p: Pokemon, options: EvolutionOption[]) =>
    options.map(({ target }) => evolutionRank(p, target, settings)).sort(compareRank)[0];
  for (const group of groups.values()) {
    group.sort((left, right) => {
      return compareRank(
        bestEvolutionRank(left.p, left.options),
        bestEvolutionRank(right.p, right.options),
      ) || left.p.id.localeCompare(right.p.id);
    });
    const winner = group[0];
    winners.set(winner.p.id, winner.options);
    for (const peer of group.slice(1))
      peers.set(peer.p.id, winner.p.id);
  }
  return { winners, peers, needsReview };
}
function pickMax(confirmed: Pokemon[], add: AddPick) {
  const maxGroups = new Map<string, Pokemon[]>();
  for (const p of confirmed) {
    const speciesId = effective(p).speciesId;
    if (!speciesId || !["dynamax", "gigantamax"].includes(p.maxStatus || ""))
      continue;
    maxGroups.set(speciesId, [...(maxGroups.get(speciesId) || []), p]);
  }
  const maxPeers = new Map<string, string>();
  for (const group of maxGroups.values()) {
    group.sort((left, right) =>
      Number(right.locked) - Number(left.locked) ||
      Number(right.maxStatus === "gigantamax") -
        Number(left.maxStatus === "gigantamax") ||
      quality(right) - quality(left) ||
      left.id.localeCompare(right.id),
    );
    add(group[0], "保留此物種的極巨化收藏代表", group);
    for (const peer of group.slice(1)) maxPeers.set(peer.id, group[0].id);
  }
  return maxPeers;
}
// Froakie and Frogadier can reach Mega Greninja after ordinary evolution.
// Pick one representative across the whole line, including Greninja already owned.
function pickMegaGreninja(
  confirmed: Pokemon[],
  snapshot: Snapshot | null,
  add: AddPick,
): LineChoice {
  const megaGreninjaIds = new Set(["froakie", "frogadier", "greninja"]);
  const megaGreninja = snapshot?.species.froakie?.evolutions.some((x) =>
    x.id === "frogadier",
  ) && snapshot.species.frogadier?.evolutions.some((x) =>
    x.id === "greninja",
  ) && snapshot.species.greninja
    ? confirmed.filter((p) => {
        const f = effective(p);
        return Boolean(
          f.speciesId && megaGreninjaIds.has(f.speciesId) &&
          f.shadow === false && f.costume === null &&
          f.ivAtk !== null && f.ivDef !== null && f.ivSta !== null,
        );
      })
    : [];
  megaGreninja.sort((left, right) => {
    const a = effective(left), b = effective(right);
    const stage = (id: string | null) =>
      id === "greninja" ? 2 : id === "frogadier" ? 1 : 0;
    return (b.ivAtk ?? 0) - (a.ivAtk ?? 0) ||
      ((b.ivAtk ?? 0) + (b.ivDef ?? 0) + (b.ivSta ?? 0)) -
        ((a.ivAtk ?? 0) + (a.ivDef ?? 0) + (a.ivSta ?? 0)) ||
      stage(b.speciesId) - stage(a.speciesId) ||
      Math.min(...right.analysis!.currentLevels) -
        Math.min(...left.analysis!.currentLevels) ||
      left.id.localeCompare(right.id);
  });
  const winner = megaGreninja[0];
  const peers = new Map<string, string>();
  if (winner) {
    add(
      winner,
      "保留超級甲賀忍蛙進化線的收藏代表",
      megaGreninja,
    );
    for (const peer of megaGreninja.slice(1))
      peers.set(peer.id, winner.id);
  }
  return { winner, peers };
}
// The reference snapshot contains ordinary Venusaur but no Mega Venusaur
// species row. Reserve the best confirmed member of its evolution line.
function pickMegaVenusaur(
  confirmed: Pokemon[],
  snapshot: Snapshot | null,
  add: AddPick,
): LineChoice {
  const megaVenusaurIds = new Set(["bulbasaur", "ivysaur", "venusaur"]);
  const megaVenusaur = snapshot?.species.bulbasaur?.evolutions.some((x) =>
    x.id === "ivysaur",
  ) && snapshot.species.ivysaur?.evolutions.some((x) =>
    x.id === "venusaur",
  ) && snapshot.species.venusaur
    ? confirmed.filter((p) => {
        const f = effective(p);
        return Boolean(
          f.speciesId && megaVenusaurIds.has(f.speciesId) &&
          f.shadow === false && f.costume === null &&
          f.ivAtk !== null && f.ivDef !== null && f.ivSta !== null,
        );
      })
    : [];
  const venusaurStage = (id: string | null) =>
    id === "venusaur" ? 2 : id === "ivysaur" ? 1 : 0;
  megaVenusaur.sort((left, right) => {
    const a = effective(left), b = effective(right);
    const total = (f: Fields) => (f.ivAtk ?? 0) + (f.ivDef ?? 0) + (f.ivSta ?? 0);
    return total(b) - total(a) ||
      (b.ivAtk ?? 0) - (a.ivAtk ?? 0) ||
      venusaurStage(b.speciesId) - venusaurStage(a.speciesId) ||
      Math.min(...right.analysis!.currentLevels) -
        Math.min(...left.analysis!.currentLevels) ||
      left.id.localeCompare(right.id);
  });
  const winner = megaVenusaur[0];
  const peers = new Map<string, string>();
  if (winner) {
    add(winner, "保留超級妙蛙花進化線的收藏代表", megaVenusaur);
    for (const peer of megaVenusaur.slice(1))
      peers.set(peer.id, winner.id);
  }
  return { winner, peers };
}
export function evaluateCollection(
  records: Pokemon[],
  snapshot: Snapshot | null,
  settings: Settings,
  completeBoxIds?: Set<string>,
): Pokemon[] {
  const result = records.map((p) => ({ ...p, analysis: assess(p, snapshot) }));
  const living = result.filter((p) => p.owned);
  const confirmed = living.filter(
    (p) =>
      p.verified &&
      !p.candidates.length &&
      p.analysis!.currentLevels.length > 0,
  );
  const selected = new Map<string, Pick[]>();
  const add: AddPick = (p, reason, peers) =>
    selected.set(p.id, [
      ...(selected.get(p.id) || []),
      { reason, peers: peers.filter((q) => q.id !== p.id).map((q) => q.id) },
    ]);
  pickCollectibles(living, settings, add);
  const highIvPeers = pickHighIv(confirmed, add);
  pickPvp(confirmed, settings, add);
  pickRaids(confirmed, settings, add);
  const evolution = chooseEvolutions(living, snapshot, settings);
  const maxPeers = pickMax(confirmed, add);
  const megaGreninja = pickMegaGreninja(confirmed, snapshot, add);
  const megaVenusaur = pickMegaVenusaur(confirmed, snapshot, add);
  const decisions = {
    snapshot,
    settings,
    completeBoxIds,
    living,
    selected,
    evolution,
    maxPeers,
    highIvPeers,
    megaGreninja,
    megaVenusaur,
  };
  for (const p of result) categorize(p, decisions);
  return result;
}
