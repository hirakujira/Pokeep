import type { Dispatch, SetStateAction } from "react";
import { ArrowDownToLine, FolderHeart, RefreshCw, Search, Smartphone } from "lucide-react";
import { categoryLabels, effective, type Pokemon } from "@/lib/types";
import type { TransferBatch } from "@/lib/iphone-types";
import {
  maxTransferSearchFilters,
  transferSearchFilters,
  transferSearchQuery,
  type TransferSearchFilter,
} from "@/lib/transfer-search-filters";
import { PokemonRow } from "./pokemon-row";
import type { Catalog, Tab } from "./types";

export function ResultsPanel({
  records,
  catalog,
  living,
  counts,
  query,
  onQuery,
  filter,
  onFilter,
  sort,
  onSort,
  showArchived,
  onShowArchived,
  checkedTransfers,
  setCheckedTransfers,
  searchExclusions,
  onToggleSearchExclusion,
  batch,
  busy,
  onSelect,
  onNavigate,
  onReevaluate,
  onStartTransfers,
}: {
  records: Pokemon[];
  catalog: Catalog;
  living: Pokemon[];
  counts: Record<string, number>;
  query: string;
  onQuery: (query: string) => void;
  filter: string;
  onFilter: (filter: string) => void;
  sort: string;
  onSort: (sort: string) => void;
  showArchived: boolean;
  onShowArchived: (showArchived: boolean) => void;
  checkedTransfers: string[];
  setCheckedTransfers: Dispatch<SetStateAction<string[]>>;
  searchExclusions: TransferSearchFilter[];
  onToggleSearchExclusion: (id: TransferSearchFilter) => void;
  batch: TransferBatch | null | undefined;
  busy: string;
  onSelect: (id: string) => void;
  onNavigate: (tab: Tab) => void;
  onReevaluate: () => void;
  onStartTransfers: (pokemonIds: string[]) => void;
}) {
  const moveNames = Object.fromEntries(catalog.moves.map((move) => [move.id, move.name]));
  const list = records
    .filter(
      (p) =>
        (showArchived || p.owned) &&
        (filter === "all" || p.analysis?.category === filter) &&
        (query === "" ||
          `${effective(p).name || ""} ${effective(p).costume || ""} ${effective(p).speciesId || ""} ${catalog.species.find((s) => s.id === effective(p).speciesId)?.dex || ""} ${effective(p).cp || ""}`
            .toLowerCase()
            .includes(query.toLowerCase())),
    )
    .sort((a, b) =>
      sort === "cp"
        ? (effective(b).cp || 0) - (effective(a).cp || 0)
        : sort === "iv"
          ? (effective(b).ivAtk || 0) +
            (effective(b).ivDef || 0) +
            (effective(b).ivSta || 0) -
            ((effective(a).ivAtk || 0) +
              (effective(a).ivDef || 0) +
              (effective(a).ivSta || 0))
          : b.createdAt.localeCompare(a.createdAt),
    );
  const visibleTransferIds = list
    .filter((p) => p.owned && p.analysis?.category === "transfer")
    .map((p) => p.id);
  const pokemonById = new Map(records.map((p) => [p.id, p]));
  const retainedEvolutionBySpecies = new Map(
    records
      .filter((p) => p.owned && p.analysis?.category === "evolve" && effective(p).speciesId)
      .map((p) => [effective(p).speciesId!, p]),
  );
  const retainedMaxBySpecies = new Map(
    records
      .filter((p) =>
        p.owned && ["dynamax", "gigantamax"].includes(p.maxStatus || "") &&
        p.analysis?.reasons.includes("保留此物種的極巨化收藏代表") &&
        effective(p).speciesId,
      )
      .map((p) => [effective(p).speciesId!, p]),
  );
  const activeCheckedTransfers = checkedTransfers.filter((id) =>
    records.some((p) => p.id === id && p.owned && p.analysis?.category === "transfer"),
  );
  const allVisibleChecked = visibleTransferIds.length > 0 &&
    visibleTransferIds.every((id) => activeCheckedTransfers.includes(id));
  const toggleTransfer = (id: string) => setCheckedTransfers((current) =>
    current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
  );
  return (
    <div className="panel results-panel">
      <div className="results-toolbar">
        <div className="filter-tabs">
          {["all", ...Object.keys(categoryLabels)].map((c) => (
            <button
              key={c}
              className={filter === c ? "active" : ""}
              onClick={() => onFilter(c)}
            >
              {c === "all"
                ? "全部"
                : categoryLabels[c as keyof typeof categoryLabels]}
              <span>
                {c === "all" ? living.length : counts[c] || 0}
              </span>
            </button>
          ))}
        </div>
        <button
          className="button small secondary"
          disabled={!!busy}
          onClick={onReevaluate}
        >
          <RefreshCw size={14} />
          重新計算建議
        </button>
      </div>
      <div className="search-toolbar">
        <label className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="搜尋名稱、造型、全國圖鑑編號或 CP"
          />
        </label>
        <div className="list-controls">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => onShowArchived(e.target.checked)}
            />
            顯示已放生
          </label>
          <select
            aria-label="排序方式"
            value={sort}
            onChange={(e) => onSort(e.target.value)}
          >
            <option value="recent">最近掃描</option>
            <option value="cp">CP 由高到低</option>
            <option value="iv">IV 總和由高到低</option>
          </select>
          <a
            className="icon-button"
            href="/api/export?format=csv"
            title="匯出 CSV"
            aria-label="匯出 CSV"
          >
            <ArrowDownToLine size={17} />
          </a>
        </div>
      </div>
      <div className="transfer-search-options">
        <strong>放生時手機搜尋排除</strong>
        <div className="transfer-search-checks">
          {transferSearchFilters.map((option) => (
            <label key={option.id} className="checkbox-label">
              <input
                type="checkbox"
                checked={searchExclusions.includes(option.id)}
                disabled={!!busy || ["approved", "running"].includes(batch?.status || "") ||
                  (!searchExclusions.includes(option.id) &&
                    searchExclusions.length >= maxTransferSearchFilters)}
                onChange={() => onToggleSearchExclusion(option.id)}
              />
              {option.label}
            </label>
          ))}
        </div>
        <small>最多勾選四種。勾選「背卡」會排除背卡，勾選「特殊服裝／活動造型」會排除特殊服裝；手機只用勾選條件搜尋一次。查詢若無法在畫面上完整核對，放生會暫停。</small>
        <code>範例：{transferSearchQuery(25, searchExclusions)}</code>
      </div>
      <div className="transfer-selection-bar">
        <span>
          已勾選 <strong>{activeCheckedTransfers.length}</strong> 隻
        </span>
        <button
          className="button small secondary"
          disabled={!activeCheckedTransfers.length || !!busy}
          onClick={() => setCheckedTransfers([])}
        >
          清除勾選
        </button>
        <button
          className="button small danger"
          disabled={
            !activeCheckedTransfers.length || !!busy ||
            ["approved", "running"].includes(batch?.status || "")
          }
          onClick={() => onStartTransfers(activeCheckedTransfers)}
        >
          放生勾選的 {activeCheckedTransfers.length} 隻
        </button>
      </div>
      {list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="transfer-check-cell">
                  <input
                    type="checkbox"
                    aria-label="勾選目前顯示的可放生寶可夢"
                    checked={allVisibleChecked}
                    disabled={!visibleTransferIds.length}
                    onChange={() => setCheckedTransfers((current) =>
                      allVisibleChecked
                        ? current.filter((id) => !visibleTransferIds.includes(id))
                        : [...new Set([...current, ...visibleTransferIds])],
                    )}
                  />
                </th>
                <th>寶可夢</th>
                <th>CP / IV</th>
                <th>建議分類</th>
                <th>判斷依據</th>
                <th>核對</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <PokemonRow
                  key={p.id}
                  pokemon={p}
                  catalog={catalog}
                  moveNames={moveNames}
                  pokemonById={pokemonById}
                  retainedEvolutionBySpecies={retainedEvolutionBySpecies}
                  retainedMaxBySpecies={retainedMaxBySpecies}
                  checked={activeCheckedTransfers.includes(p.id)}
                  onToggle={toggleTransfer}
                  onSelect={onSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="large-empty">
          <div>
            <FolderHeart size={32} strokeWidth={1.3} />
          </div>
          <h3>
            {records.length
              ? "沒有符合條件的寶可夢"
              : "還沒有掃描資料"}
          </h3>
          <p>
            {records.length
              ? "換個分類或搜尋條件試試。"
              : "用 iPhone 掃描後，結果會列在這裡。"}
          </p>
          {!records.length && (
            <button
              className="button primary"
              onClick={() => onNavigate("iphone")}
            >
              <Smartphone size={16} />
              開始掃描
            </button>
          )}
        </div>
      )}
      <div className="table-footer">
        <span>共 {list.length} 隻</span>
        <span>
          像素圖：
          <a
            href="https://github.com/PokeAPI/sprites"
            target="_blank"
            rel="noopener noreferrer"
          >
            PokéAPI Sprites
          </a>
        </span>
      </div>
    </div>
  );
}
