import {
  effective,
  knownMaxStatus,
  type Analysis,
  type Fields,
  type Pokemon,
  type Settings,
  type Snapshot,
  type Species,
} from "../types";
import { specialStateFromMoves } from "../iphone-safety";
import { moveName } from "../move-names";
import { moveId, moveTraining, type CombatPick } from "./move-training";
import { holdsSameForm, visualForm } from "./forms";
import { reviewReason } from "./review";
import { stepCandy } from "./evolution";

export type Pick = { reason: string; peers: string[] } & CombatPick;
export type EvolutionOption = {
  target: Species;
  candy: number;
  candyPurified?: number;
  condition: string | null;
  /** The target is the Pokémon's own Mega Evolution or Primal Reversion. */
  mega?: boolean;
};
export type EvolutionChoice = {
  winners: Map<string, EvolutionOption[]>;
  peers: Map<string, string>;
  needsReview: Set<string>;
};
export type LineChoice = { winner: Pokemon | undefined; peers: Map<string, string> };
export type CollectionDecisions = {
  snapshot: Snapshot | null;
  settings: Settings;
  completeBoxIds?: Set<string>;
  living: Pokemon[];
  selected: Map<string, Pick[]>;
  evolution: EvolutionChoice;
  maxPeers: Map<string, string>;
  highIvPeers: Map<string, string>;
  megaGreninja: LineChoice;
  megaVenusaur: LineChoice;
};

const rarityLabels = [
  ["mythical", "幻之寶可夢"],
  ["legendary", "傳說寶可夢"],
  ["ultrabeast", "究極異獸"],
] as const;
function rarity(f: Fields, snapshot: Snapshot | null) {
  const tags = f.speciesId ? snapshot?.species[f.speciesId]?.tags : undefined;
  return rarityLabels.find(([tag]) => tags?.includes(tag))?.[1] ?? null;
}
// Keep reasons in display order; the results list shows only reasons[0].
// Anything unmatched (comparison notes such as 已人工確認…) sorts last.
const keepReasonOrder = [
  /^已由你鎖定保留$/,
  /^已確認色違/,
  /入選 ?(PvP|團體戰)/,
  new RegExp(`^(${rarityLabels.map(([, label]) => label).join("|")})，`),
  /^特殊造型保留|收藏代表（同組前 \d+ 名）$/,
  /^保留此物種的極巨化收藏代表$/,
  /^保留超級.+進化線的收藏代表$/,
  /高 IV 收藏代表$/,
  /^進化結果不明；保留/,
];
function keepReasonRank(reason: string) {
  const index = keepReasonOrder.findIndex((pattern) => pattern.test(reason));
  return index < 0 ? keepReasonOrder.length : index;
}
function unresolvedMissingEvolution(
  pokemon: Pokemon,
  living: Pokemon[],
  snapshot: Snapshot | null,
) {
  if (pokemon.evolutionSilhouette != null || !snapshot)
    return false;
  const fields = effective(pokemon);
  const species = fields.speciesId ? snapshot.species[fields.speciesId] : null;
  if (!species) return false;
  const form = visualForm(fields, species, snapshot)?.id ?? null;
  return species.evolutions.some((evolution) => {
    const target = snapshot.species[evolution.id];
    return (!evolution.gender || evolution.gender === fields.gender) &&
      Boolean(target) && !holdsSameForm(living, target, form, snapshot);
  });
}
function comparedWith(id: string, picks: Pick[], d: CollectionDecisions) {
  const peers = [...new Set(picks.flatMap((x) => x.peers))];
  if (d.evolution.peers.has(id))
    peers.push(d.evolution.peers.get(id)!);
  if (d.maxPeers.has(id))
    peers.push(d.maxPeers.get(id)!);
  if (d.megaGreninja.peers.has(id))
    peers.push(d.megaGreninja.peers.get(id)!);
  if (d.megaVenusaur.peers.has(id))
    peers.push(d.megaVenusaur.peers.get(id)!);
  if (d.highIvPeers.has(id))
    peers.push(d.highIvPeers.get(id)!);
  return [...new Set(peers)];
}
function recommendEvolution(
  p: Pokemon,
  f: Fields,
  a: Analysis,
  evolution: EvolutionOption[],
  completeBoxIds?: Set<string>,
) {
  a.category = "evolve";
  if (evolution[0].mega) {
    // Kyogre and Groudon are the only Pokémon with Primal Reversion.
    const kind = /^(kyogre|groudon)$/.test(evolution[0].target.id) ? "原始回歸" : "超級進化";
    a.reasons.unshift(`${kind}按鈕顯示未登錄剪影；同類中優先${kind}這隻`);
    a.actions.unshift(`可考慮${kind}以登錄圖鑑。`);
    return;
  }
  a.evolutionCandy = {
    available: f.candy,
    options: evolution.map((option) => ({
      speciesId: option.target.id,
      name: option.target.name,
      required: stepCandy(option, f.purified),
      condition: option.condition,
    })),
  };
  const coverage = completeBoxIds?.has(p.id)
    ? "最近一次完整盒子掃描"
    : "已匯入且仍持有的收藏（盒子掃描未完成）";
  if (evolution.length === 1) {
    a.reasons.unshift(
      `進化按鈕顯示未登錄剪影；${coverage}沒有 ${evolution[0].target.name}；同類中優先進化這隻`,
    );
    a.actions.unshift(
      `可考慮進化為 ${evolution[0].target.name}${evolution[0].condition ? `；條件：${evolution[0].condition}` : ""}。`,
    );
  } else {
    const names = evolution.map(({ target }) => target.name).join("、");
    a.reasons.unshift(
      `進化按鈕顯示未登錄剪影；${coverage}沒有下一階分支（${names}）；同類中優先進化這隻`,
    );
    a.actions.unshift(`可考慮進化為 ${names}；請在遊戲確認分支與進化道具。`);
  }
}
function assignCategory(
  p: Pokemon,
  f: Fields,
  a: Analysis,
  picks: Pick[],
  hasCombat: boolean,
  d: CollectionDecisions,
) {
  const snapshot = d.snapshot;
  const evolution = d.evolution.winners.get(p.id);
  const rare = rarity(f, snapshot);
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
    recommendEvolution(p, f, a, evolution, d.completeBoxIds);
  } else if (d.evolution.needsReview.has(p.id)) {
    a.category = "review";
    a.reasons.unshift("有未登錄進化剪影，但多分支與收藏狀態無法唯一對應；請人工核對");
  } else if (p.evolutionSilhouette === true && !d.evolution.peers.has(p.id)) {
    a.category = "review";
    a.reasons.unshift("進化按鈕顯示未登錄剪影，但已匯入收藏中有下一階進化型，或進化目標無法確認；核對前不列入可放生");
  } else if (unresolvedMissingEvolution(p, d.living, snapshot)) {
    a.category = "review";
    a.reasons.unshift("已匯入收藏缺少下一階進化型，但進化剪影尚未判定；確認前不列入可放生");
  } else if (a.warnings.some((w) => w.includes("不完整") || w.includes("不適用"))) {
    a.category = "review";
    a.reasons.unshift(reviewReason(p, f, a));
  } else if (hasCombat) a.category = "invest";
  else if (picks.length) a.category = "collect";
  else if (p.evolutionSilhouette === "unknown-branch") {
    a.category = "collect";
    a.reasons.unshift("進化結果不明；保留待確認目標與進化方式");
  }
  else if (rare) a.category = "collect";
  else if (knownMaxStatus(p, snapshot.species[f.speciesId]) == null) {
    a.category = "review";
    a.reasons.unshift("極巨化狀態未能從能力頁確認，放生前請核對");
  }
  else if (f.costume !== null) {
    a.category = "collect";
    a.reasons.unshift("特殊造型保留，不列入自動放生候選");
  }
  else {
    a.category = "transfer";
    a.reasons.push(
      "在已匯入且仍持有的個體中，未入選收藏代表、PvP 名額或團體戰隊伍",
    );
  }
  if (rare && (a.category === "collect" || a.category === "invest"))
    a.reasons.unshift(`${rare}，保留且不列入放生候選`);
}
function addPeerReasons(p: Pokemon, a: Analysis, d: CollectionDecisions) {
  if (p.evolutionSilhouette === "unavailable")
    a.reasons.push("已人工確認此個體沒有進化按鈕");
  if (p.evolutionSilhouette === "unknown-branch")
    a.reasons.push("進化結果尚未對應到特定形態，不能據此判定哪個進化型尚未登錄");
  if (d.evolution.peers.has(p.id))
    a.reasons.push("同類已有更適合進化的個體");
  if (d.maxPeers.has(p.id))
    a.reasons.push("同物種已有保留的極巨化個體");
  if (d.highIvPeers.has(p.id))
    a.reasons.push("同物種已有 IV 更高的保留個體");
  if (d.megaGreninja.peers.has(p.id) && d.megaGreninja.winner) {
    const winner = effective(d.megaGreninja.winner);
    const reason = `已保留 ${winner.name || "甲賀忍蛙"} CP ${winner.cp ?? "?"} 作超級甲賀忍蛙進化線代表`;
    if (a.category === "transfer") a.reasons.unshift(reason);
    else a.reasons.push(reason);
  }
  if (d.megaVenusaur.peers.has(p.id) && d.megaVenusaur.winner) {
    const winner = effective(d.megaVenusaur.winner);
    const reason = `已保留妙蛙花進化線 CP ${winner.cp ?? "?"} 作超級妙蛙花代表`;
    if (a.category === "transfer") a.reasons.unshift(reason);
    else a.reasons.push(reason);
  }
}
function addCombatActions(
  a: Analysis,
  f: Fields,
  snapshot: Snapshot | null,
  settings: Settings,
) {
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
    const currentMoves = [f.fastMove, f.chargeMove, f.chargeMove2]
      .filter(Boolean)
      .map((v) => moveId(v!, snapshot));
    const missing = bestLeague.moves.filter(
      (m) => !currentMoves.includes(m),
    );
    if (missing.length)
      a.actions.push(
        `PvP 目標招式：${bestLeague.moves.map((m) => moveName(m, snapshot?.moveNames)).join("／")}。缺少 ${missing.map((m) => moveName(m, snapshot?.moveNames)).join("、")}；該用哪種學習器見下方「招式學習器」。`,
      );
    if (!f.chargeMove2) {
      const unlock = secondMoveCost(f, snapshot);
      a.actions.push(
        `PvP 通常需第二特殊招式；${unlock ? `開招需 ${unlock.dust.toLocaleString()} 星塵及 ${unlock.candy} 糖果` : "請核對遊戲中的開招成本"}。`,
      );
    }
  }
}
// Shadow Pokémon pay 1.2× and purified Pokémon 0.8× the regular cost. Smeargle
// lists no stardust and an unreachable candy cost.
function secondMoveCost(f: Fields, snapshot: Snapshot | null) {
  const cost = f.speciesId ? snapshot?.species[f.speciesId]?.thirdMove : null;
  if (!cost?.dust) return null;
  const rate = f.shadow ? 1.2 : f.purified ? 0.8 : 1;
  return { dust: Math.round(cost.dust * rate), candy: Math.round(cost.candy * rate) };
}
export function categorize(p: Pokemon, d: CollectionDecisions) {
  const a = p.analysis!,
    f = effective(p),
    picks = d.selected.get(p.id) || [];
  const hasCombat = picks.some((x) => !x.reason.includes("收藏"));
  a.comparedWith = comparedWith(p.id, picks, d);
  if (!p.owned) {
    a.category = "collect";
    a.reasons = ["已標記離開收藏庫，不參與現有個體比較"];
    return;
  }
  assignCategory(p, f, a, picks, hasCombat, d);
  addPeerReasons(p, a, d);
  a.reasons.push(...picks.map((x) => x.reason));
  if (hasCombat) {
    addCombatActions(a, f, d.snapshot, d.settings);
    if (d.snapshot) a.moveTraining = moveTraining(f, picks, d.snapshot);
  }
  a.reasons = [...new Set(a.reasons)];
  if (a.category === "collect" || a.category === "invest")
    a.reasons.sort((x, y) => keepReasonRank(x) - keepReasonRank(y));
}
