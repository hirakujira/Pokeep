import type { Evidence, Analysis, Pokemon } from "@/lib/types";
import { localizeSpeciesName } from "@/lib/species-names";
import type { Catalog } from "./types";

export const number = (n: number) => n.toLocaleString("zh-TW");
export const date = (v: string) =>
  new Date(v).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export const duration = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return "資料不足";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
};
export const sourceTime = (source: Evidence) =>
  source.source === "iphone"
    ? source.capturedAt
      ? date(source.capturedAt)
      : "擷取時間未知"
    : `${source.time.toFixed(2)} 秒`;
export const sourceName = (source: Evidence) =>
  source.source === "iphone" ? "iPhone 掃描" : source.video;
export const speciesLabel = (
  catalog: Catalog,
  speciesId: string | null,
  fallbackName?: string | null,
) => {
  if (!speciesId) return "尚未指定物種";
  const species = catalog.species.find((row) => row.id === speciesId);
  return species
    ? `#${species.dex} ${localizeSpeciesName(species.name, species.id)}`
    : fallbackName ? localizeSpeciesName(fallbackName, speciesId) : "圖鑑資料載入中";
};
export const displayPokemonName = (name: string, costume: string | null, speciesId?: string | null) => {
  const localized = localizeSpeciesName(name, speciesId);
  return costume && !localized.includes(costume) ? `${localized}（${costume}）` : localized;
};
export const reviewPromptsFor = (pokemon: Pokemon) => [...new Set([
  ...(pokemon.analysis?.category === "review"
    ? pokemon.analysis.reasons.filter((reason) => !/^(已人工確認|已保留|保留此)|收藏代表（同組前/.test(reason))
    : []),
  ...pokemon.issues,
])];
export function evolutionCandySummary(plan: Analysis["evolutionCandy"]) {
  if (!plan?.options.length) return null;
  const requirements = plan.options.map((option) => option.required);
  const minimum = Math.min(...requirements);
  const maximum = Math.max(...requirements);
  const available = plan.available;
  if (available === null) return {
    tone: "unknown",
    label: minimum === maximum
      ? `糖果持有量未知（需要 ${minimum}）`
      : `糖果持有量未知（需要 ${minimum}–${maximum}）`,
  };
  if (available >= maximum) return {
    tone: "enough",
    label: `糖果足夠（持有 ${available}／${minimum === maximum ? "需要" : "最高需"} ${maximum}）`,
  };
  if (available < minimum) return {
    tone: "insufficient",
    label: `糖果不足（持有 ${available}／${minimum === maximum ? "需要" : "至少需"} ${minimum}）`,
  };
  return {
    tone: "partial",
    label: `部分分支糖果足夠（持有 ${available}／需要 ${minimum}–${maximum}）`,
  };
}
