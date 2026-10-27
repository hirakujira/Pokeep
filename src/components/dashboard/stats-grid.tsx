import { categoryLabels, type Pokemon } from "@/lib/types";
import { icons } from "./constants";

export function StatsGrid({
  living,
  counts,
  loading,
  filter,
  onFilter,
}: {
  living: Pokemon[];
  counts: Record<string, number>;
  loading: boolean;
  filter: string;
  onFilter: (filter: string) => void;
}) {
  const reviewRows = living.filter((p) => p.analysis?.category === "review");
  const reviewUnverified = reviewRows.filter((p) => !p.verified).length;
  const reviewAnalysisLimited = reviewRows.length - reviewUnverified;
  return (
    <div className="stats-grid">
      {(
        Object.keys(categoryLabels) as (keyof typeof categoryLabels)[]
      ).map((category) => {
        const Icon = icons[category];
        return (
          <button
            key={category}
            className={`stat-card ${category} ${filter === category ? "active" : ""}`}
            aria-pressed={filter === category}
            onClick={() => onFilter(category)}
          >
            <div className="stat-top">
              <Icon size={16} />
              <span>{categoryLabels[category]}</span>
            </div>
            <div className="stat-number">
              {loading ? (
                <span className="skeleton-number" />
              ) : (
                counts[category] || 0
              )}
              <span>隻</span>
            </div>
            <div className="stat-caption">
              {category === "review" && !loading
                ? `未核對 ${reviewUnverified} · 依據不足 ${reviewAnalysisLimited}`
                : {
                    transfer: "沒有保留理由",
                    collect: "異色、鎖定或收藏代表",
                    invest: "團體戰或 PvP 有用",
                    evolve: "進化型未登錄，同種留一隻",
                    review: "未核對或資料不足",
                  }[category]}
            </div>
          </button>
        );
      })}
    </div>
  );
}
