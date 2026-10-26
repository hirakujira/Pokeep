import {
  effective,
  type Analysis,
  type Cost,
  type Fields,
  type LeagueResult,
  type Pokemon,
  type RaidResult,
  type Settings,
  type Snapshot,
  type Species,
} from "./types";
import {
  all,
  getSettings,
  getSnapshot,
  listPokemon,
  now,
  put,
  transaction,
} from "./store";
import { blockingEvidenceIssues, specialStateFromMoves } from "./iphone-safety";
import { moveName } from "./move-names";
import { typeName } from "./type-names";
import type { Scan, ScanItem } from "./iphone-types";

function reviewReason(p: Pokemon, f: Fields, a: Analysis) {
  if (p.candidates.length) return "與既有個體配對不明，請核對是否為同一隻";
  if (specialStateFromMoves(f).conflict)
    return "招式與暗影／淨化狀態衝突，請人工核對";
  const evidenceIssue = blockingEvidenceIssues(p.issues, f)[0];
  if (evidenceIssue) return evidenceIssue;
  if (!f.speciesId) return "物種或形態尚未確認";
  if (f.cp === null || [f.ivAtk, f.ivDef, f.ivSta].some((v) => v === null))
    return "CP 或 IV 資料不完整";
  if (f.shiny === null) return "色違狀態無法從截圖確認";
  if (f.shadow === null || f.purified === null)
    return "暗影或淨化狀態尚未確認";
  if (f.favorite === null) return "最愛狀態尚未確認";
  if (f.gender === null) return "性別尚未辨識";
  if (f.hp === null || f.height === null || f.weight === null)
    return "HP、身高或體重資料不完整";
  if (!a.currentLevels.length) return "CP、HP 與 IV 無法對應合理等級";
  if (!p.verified) return "多畫面證據尚未通過自動核對";
  const analysisGap = a.warnings.find(
    (warning) => warning.includes("不完整") || warning.includes("不適用"),
  );
  if (analysisGap) return `已核對個體；${analysisGap}`;
  return "資料或配對尚待核對，暫不給放生結論";
}

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
type EvolutionPath = { s: Species; candy: number; condition: string | null };
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
function raidBenchmarks(snapshot: Snapshot) {
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
    purification: null,
    comparedWith: [],
    snapshot: snapshot?.version || null,
    evaluatedAt: now(),
  };
}
function assess(p: Pokemon, snapshot: Snapshot | null): Analysis {
  const a = baseAnalysis(p, snapshot),
    f = effective(p),
    s = f.speciesId ? snapshot?.species[f.speciesId] : null;
  if (!snapshot || !s) {
    a.reasons.push("缺少物種或遊戲資料，無法可靠評估");
    return a;
  }
  if (f.shadow === null || f.shiny === null || f.purified === null)
    a.warnings.push("暗影、淨化或色違狀態未確認");
  const prefix = `${s.id.replace(/_shadow$/, "")}/${f.form || s.form || "normal"}/${f.costume || "none"}/${Boolean(f.shiny)}/${Boolean(f.shadow)}`;
  if (f.shiny) a.collectionKeys.push(`${prefix}/shiny`);
  if (f.costume) a.collectionKeys.push(`${prefix}/costume`);
  if (s.form) a.collectionKeys.push(`${prefix}/form`);
  if (s.tags.some((t) => ["legendary", "mythical", "ultrabeast"].includes(t)))
    a.collectionKeys.push(`${prefix}/rare`);
  const iv = [f.ivAtk, f.ivDef, f.ivSta];
  if (iv.every((v) => v === 15)) a.collectionKeys.push(`${prefix}/perfect`);
  if (iv.every((v) => v === 0)) a.collectionKeys.push(`${prefix}/zero`);
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
    const target = path.s;
    const missingPveMoves = [...target.fast, ...target.charged].filter(
      (move) => !snapshot.moves[move],
    );
    if (missingPveMoves.length)
      a.warnings.push(
        `${target.id === s.id ? "目前形態" : "可能進化形態"} ${target.name} 的招式 ${missingPveMoves
          .map((move) => moveName(move, snapshot.moveNames))
          .join("、")} 缺少團體戰（PvE）威力／時長資料，團體戰輸出比較不完整`,
      );
    for (const cap of [1500, 2500, 10000]) {
      const ranking = snapshot.rankings[String(cap)] || [],
        index = ranking.findIndex((r) => r.speciesId === target.id),
        r = rankIV(target, values, cap, snapshot);
      if (!r.level) continue;
      const cost =
        current === null ? null : powerCost(current, r.level, f, snapshot);
      if (cost)
        cost.candy += f.purified ? Math.ceil(path.candy * 0.9) : path.candy;
      a.leagues.push({
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
          a.currentLevels.length > 0 && Math.min(...a.currentLevels) <= r.level,
        buddyCp: combatPower(
          target,
          values,
          Math.min(51, r.level + 1),
          snapshot,
        ),
      });
    }
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
      a.raids.push({
        ...row,
        name: target.name,
        dps: cycleDps(target, values[0], 35, row.fast, row.charge, snapshot),
        elite: [row.fast, row.charge].filter((m) => target.elite.includes(m)),
        targets,
        condition: path.condition,
      });
    }
  }
  if (f.shadow) {
    const purifiedIv = values.map((v) => Math.min(15, v + 2));
    const regular = snapshot.species[s.id.replace(/_shadow$/, "")];
    a.purification = {
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
        a.purification.verdict =
          "淨化後可能取得 PvP 價值；請先核對遷怒／報恩與進化條件，再決定淨化。";
    }
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
  const selected = new Map<string, { reason: string; peers: string[] }[]>();
  const add = (p: Pokemon, reason: string, peers: Pokemon[]) =>
    selected.set(p.id, [
      ...(selected.get(p.id) || []),
      { reason, peers: peers.filter((q) => q.id !== p.id).map((q) => q.id) },
    ]);
  const quality = (p: Pokemon) => {
    const f = effective(p);
    return (
      (p.locked ? 10000 : 0) +
      (p.verified ? 1000 : 0) +
      (f.ivAtk || 0) +
      (f.ivDef || 0) +
      (f.ivSta || 0) +
      (f.cp || 0) / 10000
    );
  };
  const collectibles = new Map<string, Pokemon[]>();
  for (const p of living)
    for (const key of p.analysis!.collectionKeys)
      collectibles.set(key, [...(collectibles.get(key) || []), p]);
  for (const peers of collectibles.values())
    peers
      .sort((a, b) => quality(b) - quality(a))
      .slice(0, settings.rareRepresentatives)
      .forEach((p) => add(p, "保留此特殊收藏的代表個體", peers));
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
  type EvolutionOption = { target: Species; condition: string | null };
  const evolutionGroups = new Map<string, { p: Pokemon; options: EvolutionOption[] }[]>();
  const evolutionNeedsReview = new Set<string>();
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
      p.evolutionSilhouette !== true || f.costume !== null ||
      !completeBoxIds?.has(p.id)
    ) continue;
    const evolutions = snapshot.species[f.speciesId]?.evolutions.filter(
      (evolution) => !evolution.gender || evolution.gender === f.gender,
    ) || [];
    const options = evolutions.flatMap((evolution) => {
      const target = snapshot.species[evolution.id];
      return target ? [{ target, condition: evolution.condition }] : [];
    });
    if (!options.length || options.length !== evolutions.length) {
      evolutionNeedsReview.add(p.id);
      continue;
    }
    const missing = options.filter(({ target }) =>
      !living.some((peer) =>
        completeBoxIds.has(peer.id) && effective(peer).speciesId === target.id,
      ),
    );
    if (missing.length !== options.length) {
      if (missing.length) evolutionNeedsReview.add(p.id);
      continue;
    }
    // The screenshot proves at least one branch is unregistered, but cannot
    // pair each silhouette with a named branch. Only infer multi-branch
    // evolution automatically when none of its immediate forms is in the box.
    const key = `${f.speciesId}/${options.map(({ target }) => target.id).sort().join(",")}`;
    evolutionGroups.set(key, [
      ...(evolutionGroups.get(key) || []),
      { p, options },
    ]);
  }
  const evolutionWinners = new Map<string, EvolutionOption[]>();
  const evolutionPeers = new Map<string, string>();
  const unresolvedMissingEvolution = (pokemon: Pokemon) => {
    if (pokemon.evolutionSilhouette != null || !completeBoxIds?.has(pokemon.id) || !snapshot)
      return false;
    const fields = effective(pokemon);
    const species = fields.speciesId ? snapshot.species[fields.speciesId] : null;
    return Boolean(species?.evolutions.some((evolution) =>
      (!evolution.gender || evolution.gender === fields.gender) &&
      snapshot.species[evolution.id] &&
      !living.some((peer) =>
        completeBoxIds.has(peer.id) && effective(peer).speciesId === evolution.id,
      ),
    ));
  };
  const evolutionRank = (p: Pokemon, target: Species) => {
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
  };
  const compareRank = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  };
  const bestEvolutionRank = (p: Pokemon, options: EvolutionOption[]) =>
    options.map(({ target }) => evolutionRank(p, target)).sort(compareRank)[0];
  for (const group of evolutionGroups.values()) {
    group.sort((left, right) => {
      return compareRank(
        bestEvolutionRank(left.p, left.options),
        bestEvolutionRank(right.p, right.options),
      ) || left.p.id.localeCompare(right.p.id);
    });
    const winner = group[0];
    evolutionWinners.set(winner.p.id, winner.options);
    for (const peer of group.slice(1))
      evolutionPeers.set(peer.p.id, winner.p.id);
  }
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
  // Froakie and Frogadier can reach Mega Greninja after ordinary evolution.
  // Pick one representative across the whole line, including Greninja already owned.
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
  const megaGreninjaWinner = megaGreninja[0];
  const megaGreninjaPeers = new Map<string, string>();
  if (megaGreninjaWinner) {
    add(
      megaGreninjaWinner,
      "保留超級甲賀忍蛙進化線的收藏代表",
      megaGreninja,
    );
    for (const peer of megaGreninja.slice(1))
      megaGreninjaPeers.set(peer.id, megaGreninjaWinner.id);
  }
  // The reference snapshot contains ordinary Venusaur but no Mega Venusaur
  // species row. Reserve the best confirmed member of its evolution line.
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
  const megaVenusaurWinner = megaVenusaur[0];
  const megaVenusaurPeers = new Map<string, string>();
  if (megaVenusaurWinner) {
    add(megaVenusaurWinner, "保留超級妙蛙花進化線的收藏代表", megaVenusaur);
    for (const peer of megaVenusaur.slice(1))
      megaVenusaurPeers.set(peer.id, megaVenusaurWinner.id);
  }
  for (const p of result) {
    const a = p.analysis!,
      f = effective(p),
      picks = selected.get(p.id) || [];
    const hasCombat = picks.some((x) => !x.reason.includes("收藏"));
    const evolution = evolutionWinners.get(p.id);
    a.comparedWith = [...new Set(picks.flatMap((x) => x.peers))];
    if (evolutionPeers.has(p.id))
      a.comparedWith.push(evolutionPeers.get(p.id)!);
    if (maxPeers.has(p.id))
      a.comparedWith.push(maxPeers.get(p.id)!);
    if (megaGreninjaPeers.has(p.id))
      a.comparedWith.push(megaGreninjaPeers.get(p.id)!);
    if (megaVenusaurPeers.has(p.id))
      a.comparedWith.push(megaVenusaurPeers.get(p.id)!);
    if (highIvPeers.has(p.id))
      a.comparedWith.push(highIvPeers.get(p.id)!);
    a.comparedWith = [...new Set(a.comparedWith)];
    if (!p.owned) {
      a.category = "collect";
      a.reasons = ["已標記離開收藏庫，不參與現有個體比較"];
      continue;
    }
    if (p.locked) {
      a.category = "collect";
      a.reasons.unshift("已由你鎖定保留");
    } else if (f.shiny === true) {
      a.category = "collect";
      a.reasons.unshift("已確認色違，保留且不列入放生候選");
    } else if (
      specialStateFromMoves(f).conflict ||
      !p.verified ||
      p.candidates.length ||
      !snapshot ||
      !f.speciesId ||
      [f.cp, f.ivAtk, f.ivDef, f.ivSta, f.shadow, f.purified, f.shiny].some(
        (v) => v === null,
      ) ||
      !a.currentLevels.length
    ) {
      a.category = "review";
      a.reasons.unshift(reviewReason(p, f, a));
    } else if (evolution) {
      a.category = "evolve";
      if (evolution.length === 1) {
        a.reasons.unshift(
          `進化按鈕顯示未登錄剪影；最近一次完整盒子掃描沒有 ${evolution[0].target.name}；同類中優先進化這隻`,
        );
        a.actions.unshift(
          `可考慮進化為 ${evolution[0].target.name}${evolution[0].condition ? `；條件：${evolution[0].condition}` : ""}。`,
        );
      } else {
        const names = evolution.map(({ target }) => target.name).join("、");
        a.reasons.unshift(
          `進化按鈕顯示未登錄剪影；最近一次完整盒子掃描沒有下一階分支（${names}）；同類中優先進化這隻`,
        );
        a.actions.unshift(`可考慮進化為 ${names}；請在遊戲確認分支與進化道具。`);
      }
    } else if (evolutionNeedsReview.has(p.id)) {
      a.category = "review";
      a.reasons.unshift("有未登錄進化剪影，但多分支與收藏狀態無法唯一對應；請人工核對");
    } else if (unresolvedMissingEvolution(p)) {
      a.category = "review";
      a.reasons.unshift("盒內缺少下一階進化型，但進化剪影尚未判定；確認前不列入可放生");
    } else if (a.warnings.some((w) => w.includes("不完整") || w.includes("不適用"))) {
      a.category = "review";
      a.reasons.unshift(reviewReason(p, f, a));
    } else if (hasCombat) a.category = "invest";
    else if (picks.length) a.category = "collect";
    else if (
      f.speciesId && snapshot?.species[f.speciesId]?.tags.some((tag) =>
        ["legendary", "mythical", "ultrabeast"].includes(tag),
      )
    ) {
      a.category = "collect";
      a.reasons.unshift("傳說、幻之或究極異獸，保留且不列入放生候選");
    }
    else if (p.maxStatus == null) {
      a.category = "review";
      a.reasons.unshift("極巨化狀態未能從能力頁確認，放生前請核對");
    }
    else {
      a.category = "transfer";
      a.reasons.push(
        "在已匯入且仍持有的個體中，未入選收藏代表、PvP 名額或團體戰隊伍",
      );
    }
    if (evolutionPeers.has(p.id))
      a.reasons.push("同類已有更適合進化的個體");
    if (maxPeers.has(p.id))
      a.reasons.push("同物種已有保留的極巨化個體");
    if (highIvPeers.has(p.id))
      a.reasons.push("同物種已有 IV 更高的保留個體");
    if (megaGreninjaPeers.has(p.id) && megaGreninjaWinner) {
      const winner = effective(megaGreninjaWinner);
      const reason = `已保留 ${winner.name || "甲賀忍蛙"} CP ${winner.cp ?? "?"} 作超級甲賀忍蛙進化線代表`;
      if (a.category === "transfer") a.reasons.unshift(reason);
      else a.reasons.push(reason);
    }
    if (megaVenusaurPeers.has(p.id) && megaVenusaurWinner) {
      const winner = effective(megaVenusaurWinner);
      const reason = `已保留妙蛙花進化線 CP ${winner.cp ?? "?"} 作超級妙蛙花代表`;
      if (a.category === "transfer") a.reasons.unshift(reason);
      else a.reasons.push(reason);
    }
    a.reasons.push(...picks.map((x) => x.reason));
    if (hasCombat) {
      const bestLeague = a.leagues
        .filter(
          (l) =>
            l.eligible &&
            l.metaRank !== null &&
            l.metaRank <= settings.metaCutoff,
        )
        .sort((a, b) => a.ivRank - b.ivRank)[0];
      const bestRaid = a.raids
        .filter((r) => r.rank <= 10)
        .sort((a, b) => a.rank - b.rank)[0];
      if (bestRaid)
        a.actions.push(
          `團體戰先比較 ${bestRaid.name} 等級 30／35 的效益；限定招式需核對取得方式${bestRaid.condition ? `，進化條件：${bestRaid.condition}` : ""}。`,
        );
      if (bestLeague)
        a.actions.push(
          `PvP 目標：${bestLeague.name}，等級 ${bestLeague.level}／CP ${bestLeague.cp}${bestLeague.level > 40 ? "；需要 XL 糖，列為長期目標" : ""}。`,
        );
      if (!f.fastMove || !f.chargeMove)
        a.actions.push("招式資料未完整：補充後才能判斷是否需要換招。");
      else if (bestLeague?.moves.length) {
        const normalizeMove = (v: string) =>
          snapshot?.moves[v]?.id ||
          Object.values(snapshot?.moves || {}).find(
            (m) => m.name === v || moveName(m.id, snapshot?.moveNames) === v,
          )?.id ||
          v;
        const currentMoves = [f.fastMove, f.chargeMove, f.chargeMove2]
          .filter(Boolean)
          .map((v) => normalizeMove(v!));
        const missing = bestLeague.moves.filter(
          (m) => !currentMoves.includes(m),
        );
        if (missing.length)
          a.actions.push(
            `PvP 目標招式：${bestLeague.moves.map((m) => moveName(m, snapshot?.moveNames)).join("／")}。缺少 ${missing.map((m) => moveName(m, snapshot?.moveNames)).join("、")}；依一般／特殊招式類型使用學習器，限定招式另核對。`,
          );
        if (!f.chargeMove2)
          a.actions.push(
            `PvP 通常需第二特殊招式；${f.secondMoveDust !== null ? `畫面顯示開招需 ${f.secondMoveDust.toLocaleString()} 星塵及 ${f.secondMoveCandy ?? "未知"} 糖果` : "請核對遊戲中的開招成本"}。`,
          );
      }
    }
    a.reasons = [...new Set(a.reasons)];
  }
  return result;
}
export function reevaluate() {
  const latestFullScan = all<Scan>("scans")
    .filter((scan) => scan.scope === "all" && scan.status === "completed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const fullItems = latestFullScan
    ? all<ScanItem>("scan_items").filter(
        (item) => item.scanId === latestFullScan.id && item.pokemonId,
      )
    : [];
  const completeBoxIds =
    latestFullScan &&
    fullItems.length === latestFullScan.scanned &&
    latestFullScan.scanned > 0
      ? new Set(fullItems.map((item) => item.pokemonId!))
      : undefined;
  const result = evaluateCollection(
    listPokemon(),
    getSnapshot(),
    getSettings(),
    completeBoxIds,
  );
  transaction(() => {
    for (const p of result) put("pokemon", p.id, p);
  });
  return result;
}
