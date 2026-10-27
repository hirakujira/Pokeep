import { useEffect, useState } from "react";
import {
  defaultTransferSearchFilters,
  transferSearchQuery,
  type TransferSearchFilter,
} from "@/lib/transfer-search-filters";

const storageKey = "pokeep-transfer-search-exclusions";

export function useTransferSearchExclusions(setError: (message: string) => void) {
  const [searchExclusions, setSearchExclusions] = useState<TransferSearchFilter[]>(defaultTransferSearchFilters);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (!Array.isArray(saved)) return;
      transferSearchQuery(25, saved);
      setSearchExclusions(saved);
    } catch { /* Keep the safe default. */ }
  }, []);
  const toggleSearchExclusion = (id: TransferSearchFilter) => {
    const next = searchExclusions.includes(id)
      ? searchExclusions.filter((entry) => entry !== id)
      : [...searchExclusions, id];
    try {
      transferSearchQuery(25, next);
      setSearchExclusions(next);
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch (error) {
      setError(error instanceof Error ? error.message : "搜尋條件無效");
    }
  };
  return { searchExclusions, toggleSearchExclusion };
}
