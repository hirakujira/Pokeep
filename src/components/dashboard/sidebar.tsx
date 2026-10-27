import { tabs } from "./constants";
import type { PhoneStatus, Tab } from "./types";
import { Logo } from "./ui";

export function Sidebar({
  tab,
  reviewCount,
  phoneStatus,
  apiConfigured,
  onNavigate,
}: {
  tab: Tab;
  reviewCount: number;
  phoneStatus: PhoneStatus;
  apiConfigured: boolean;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <aside className="sidebar">
      <Logo />
      <nav aria-label="主要功能">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? "active" : ""}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => onNavigate(t.id)}
          >
            <t.icon size={18} />
            <span>{t.label}</span>
            {t.id === "results" && reviewCount > 0 && (
              <span className="nav-count" title="待確認">
                {reviewCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <dl className="sidebar-status">
        <div>
          <dt>iPhone</dt>
          <dd className={phoneStatus.tone}>{phoneStatus.label}</dd>
        </div>
        <div>
          <dt>AI 辨識</dt>
          <dd className={apiConfigured ? "ok" : "warn"}>
            {apiConfigured ? "已設定" : "未設定"}
          </dd>
        </div>
      </dl>
    </aside>
  );
}
