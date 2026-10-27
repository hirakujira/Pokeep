/** Pokémon GO's Traditional Chinese inventory search terms used during transfer. */
export const transferSearchFilters = [
  { id: "background", label: "背卡", term: "背卡" },
  { id: "lucky", label: "亮晶晶", term: "亮晶晶" },
  { id: "shiny", label: "異色", term: "異色" },
  { id: "costume", label: "特殊服裝／活動造型", term: "特殊" },
  { id: "shadow", label: "暗影", term: "暗影" },
  { id: "purified", label: "淨化", term: "淨化" },
  { id: "favorite", label: "我的最愛", term: "我的最愛" },
  { id: "legendary", label: "傳說", term: "傳說" },
  { id: "mythical", label: "幻之", term: "幻" },
  { id: "ultrabeast", label: "究極異獸", term: "究極異獸" },
  { id: "perfect", label: "滿 IV（4★）", term: "4*" },
] as const;

export type TransferSearchFilter = (typeof transferSearchFilters)[number]["id"];
export const maxTransferSearchFilters = 4;
export const defaultTransferSearchFilters: TransferSearchFilter[] = ["background"];

export function transferSearchQuery(
  dex: number, selectedFilters: readonly TransferSearchFilter[] = defaultTransferSearchFilters,
) {
  if (!Number.isInteger(dex) || dex < 1 || dex > 10000)
    throw new Error("沒有可靠的圖鑑編號，無法搜尋候選");
  if (selectedFilters.length > maxTransferSearchFilters ||
      new Set(selectedFilters).size !== selectedFilters.length)
    throw new Error("搜尋排除條件最多四項且不能重複");
  const requested = new Set<string>(selectedFilters);
  const selected = transferSearchFilters.filter((filter) => requested.has(filter.id));
  if (selected.length !== selectedFilters.length)
    throw new Error("不支援的放生搜尋條件");
  return `${dex}${selected.map((filter) => `&!${filter.term}`).join("")}`;
}

/** No arbitrary text reaches WDA's keyboard endpoint. */
export function allowedPhoneSearchQuery(query: string) {
  const match = query.match(/^([1-9]\d{0,4})(.*)$/);
  if (!match || Number(match[1]) > 10000) return false;
  const suffix = match[2];
  if (suffix === "" || suffix === "&背卡") return true;
  const parts = suffix.split("&!");
  if (parts[0] !== "" || parts.length < 2) return false;
  const selected = parts.slice(1)
    .map((term) => transferSearchFilters.find((filter) => filter.term === term)?.id);
  if (selected.some((id) => !id)) return false;
  try {
    return query === transferSearchQuery(Number(match[1]), selected as TransferSearchFilter[]);
  } catch {
    return false;
  }
}
