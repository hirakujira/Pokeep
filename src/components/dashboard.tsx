"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Database,
  Film,
  FolderHeart,
  Info,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Swords,
  Trash2,
  Upload,
  Smartphone,
  X,
} from "lucide-react";
import {
  categoryLabels,
  defaultSettings,
  effective,
  fieldLabels,
  type Fields,
  type Evidence,
  type Pokemon,
  type Settings,
  type Cost,
} from "@/lib/types";
import type { Scan, TransferBatch } from "@/lib/iphone-types";
import type { ScanTiming } from "@/lib/scan-timing";
import type { PublicRuntimeConfig } from "@/lib/runtime-config";
import { resumableTransferIndexes, skippableTransferIndex } from "@/lib/iphone-resume";
import {
  defaultTransferSearchFilters,
  maxExtraTransferSearchFilters,
  transferSearchFilters,
  transferSearchQuery,
  type TransferSearchFilter,
} from "@/lib/transfer-search-filters";
import { localizeMoveText, moveName } from "@/lib/move-names";
import { localizeSpeciesName } from "@/lib/species-names";
import { typeName } from "@/lib/type-names";

type SnapshotInfo = {
  version: string;
  updatedAt: string;
  sourceDate: string;
  count: number;
  sources: { name: string; url: string; version: string }[];
  warnings: string[];
};
type State = {
  pokemon: Pokemon[];
  settings: Settings;
  snapshot: SnapshotInfo | null;
  apiConfigured: boolean;
  model: string;
  runtime: PublicRuntimeConfig;
};
type Catalog = {
  species: { id: string; dex: number; name: string; types: string[] }[];
  moves: { id: string; name: string }[];
};
type Tab = "iphone" | "results" | "collection" | "settings";
type PhoneState = {
  worker: {
    updatedAt: string;
    ready: boolean;
    message: string;
    version: string | null;
  } | null;
  scan: (Scan & { timing?: ScanTiming }) | null;
  batch: TransferBatch | null;
  resumableBatches: (TransferBatch & { resumeBlocked: string | null })[];
};
const empty: State = {
  pokemon: [],
  settings: defaultSettings,
  snapshot: null,
  apiConfigured: false,
  model: "gpt-4.1-mini",
  runtime: {
    apiConfigured: false,
    model: "gpt-4.1-mini",
    baseUrl: "",
    analysisConcurrency: 6,
    shinyReviewConcurrency: 6,
    iphoneUseRoot: "/Users/Hiraku/Develop/utils/iPhone-use",
    iphoneUsePython: "python3",
  },
};
const tabs = [
  { id: "iphone" as Tab, label: "iPhone 掃描", icon: Smartphone },
  { id: "results" as Tab, label: "清倉結果", icon: ClipboardCheck },
  { id: "collection" as Tab, label: "收藏庫", icon: FolderHeart },
  { id: "settings" as Tab, label: "設定", icon: Settings2 },
];
const scanStatusLabels: Record<Scan["status"], string> = {
  queued: "排隊中",
  running: "進行中",
  paused: "已暫停",
  completed: "已完成",
  stopped: "已停止",
  failed: "失敗",
};
const entryStatusLabels: Record<TransferBatch["entries"][number]["status"], string> = {
  pending: "等待中",
  searching: "搜尋中",
  unfavoriting: "取消最愛中",
  prepared: "準備放生",
  sent: "已送出",
  submitted: "已點擊放生（未核對遊戲結果）",
  confirmed: "已放生",
  skipped: "已跳過",
  uncertain: "結果不確定",
};
const icons = {
  transfer: Trash2,
  collect: FolderHeart,
  invest: Swords,
  evolve: ArrowUpRight,
  review: CircleHelp,
};
const number = (n: number) => n.toLocaleString("zh-TW");
const date = (v: string) =>
  new Date(v).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const duration = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return "資料不足";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
};
const sourceTime = (source: Evidence) =>
  source.source === "iphone"
    ? source.capturedAt
      ? date(source.capturedAt)
      : "擷取時間未知"
    : `${source.time.toFixed(2)} 秒`;
const sourceName = (source: Evidence) =>
  source.source === "iphone" ? "iPhone 掃描" : source.video;
const speciesLabel = (
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
const displayPokemonName = (name: string, costume: string | null, speciesId?: string | null) => {
  const localized = localizeSpeciesName(name, speciesId);
  return costume && !localized.includes(costume) ? `${localized}（${costume}）` : localized;
};
async function api<T = unknown>(
  url: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const r = await fetch(`/api/${url}`, {
    method,
    headers: {
      "x-pogo-local": "1",
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "操作失敗");
  return result;
}
function CostLine({ cost }: { cost: Cost | null }) {
  return cost ? (
    <span className="cost">
      {number(cost.dust)} 星塵 · {cost.candy} 糖
      {cost.xl > 0 ? ` · ${cost.xl} XL` : ""}
      <small>估算</small>
    </span>
  ) : (
    <span className="muted">目前等級未確定，成本待核對</span>
  );
}
function Status({ category }: { category: keyof typeof categoryLabels }) {
  const Icon = icons[category];
  return (
    <span className={`badge ${category}`}>
      <Icon size={13} />
      {categoryLabels[category]}
    </span>
  );
}
function Logo() {
  return (
    <div className="logo">
      <span className="brand-symbol" aria-hidden="true">
        <i />
      </span>
      Pokéep
    </div>
  );
}

function PokemonSprite({ pokemon }: { pokemon: Pokemon }) {
  const fields = effective(pokemon);
  const source = fields.speciesId
    ? `/api/sprites/${encodeURIComponent(fields.speciesId)}?shiny=${fields.shiny ? "1" : "0"}`
    : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span
      className="pokemon-token pokemon-sprite"
      title="PokéAPI 像素圖；特殊服裝以來源截圖為準"
    >
      {source && failedSource !== source ? (
        <img
          src={source}
          alt={`${fields.name || fields.speciesId}的物種參考像素圖`}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <Layers3 size={23} aria-label="沒有可用的像素圖" />
      )}
      {pokemon.locked ? (
        <span className="pokemon-sprite-badge" title="已鎖定">
          <LockKeyhole size={10} />
        </span>
      ) : fields.shadow ? (
        <span className="pokemon-sprite-badge" title="暗影寶可夢">
          ◈
        </span>
      ) : null}
    </span>
  );
}

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("iphone"),
    [state, setState] = useState<State>(empty),
    [catalog, setCatalog] = useState<Catalog>({ species: [], moves: [] });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState("");
  const [phoneState, setPhoneState] = useState<PhoneState | null>(null),
    [scanScope, setScanScope] = useState<"results" | "all">("results"),
    [trackedBatchId, setTrackedBatchId] = useState<string | null>(null),
    [dismissedBatchId, setDismissedBatchId] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("recent"),
    [selected, setSelected] = useState<string | null>(null),
    [checkedTransfers, setCheckedTransfers] = useState<string[]>([]),
    [searchExclusions, setSearchExclusions] = useState<TransferSearchFilter[]>(defaultTransferSearchFilters),
    [showArchived, setShowArchived] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("pokeep-transfer-search-exclusions") || "null");
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
      localStorage.setItem("pokeep-transfer-search-exclusions", JSON.stringify(next));
    } catch (error) {
      setError(error instanceof Error ? error.message : "搜尋條件無效");
    }
  };
  const closeDrawer = useCallback(() => setSelected(null), []);
  const backupInput = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await api<State>("state");
      setState(result);
      setError("");
      setLoading(false);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }, []);
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api<Catalog>("species"));
    } catch {}
  }, []);
  const refreshPhone = useCallback(async () => {
    try {
      setPhoneState(await api<PhoneState>("iphone"));
    } catch {
      /* main state keeps its own error */
    }
  }, []);
  useEffect(() => {
    void refresh();
    void loadCatalog();
    void refreshPhone();
  }, [refresh, loadCatalog, refreshPhone]);
  useEffect(() => {
    const timer = setInterval(() => void refreshPhone(), 3000);
    return () => clearInterval(timer);
  }, [refreshPhone]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const notify = (message: string) => setToast(message);
  const phoneAct = async (label: string, fn: () => Promise<void>) => {
    await act(label, fn);
    await refreshPhone();
  };
  const startSelectedTransfers = (pokemonIds: string[]) => {
    void phoneAct("execute-many", async () => {
      const batch = await api<TransferBatch>("transfers/execute-many", "POST", {
        pokemonIds, searchExclusions,
      });
      setTrackedBatchId(batch.id);
      setDismissedBatchId(null);
      notify(`已開始放生 ${pokemonIds.length} 隻`);
    });
  };
  const skipTransferEntry = (pausedBatch: TransferBatch) => {
    void phoneAct("skip-transfer-entry", async () => {
      const skipped = await api<TransferBatch>(`transfers/${pausedBatch.id}/skip-current`, "POST");
      setTrackedBatchId(skipped.id);
      setDismissedBatchId(null);
      const newlyExcluded = skipped.entries.filter((entry, index) =>
        pausedBatch.entries[index]?.status === "pending" && entry.status === "skipped",
      ).length;
      notify(`已跳過這隻${newlyExcluded ? `，另有 ${newlyExcluded} 隻不再符合放生條件也已跳過` : ""}；繼續放生剩餘 ${skipped.entries.filter((entry) => entry.status === "pending").length} 隻`);
    });
  };
  const navigate = (next: Tab) => {
    setTab(next);
    setQuery("");
    setFilter("all");
  };
  const living = state.pokemon.filter((p) => p.owned),
    moveNames = Object.fromEntries(catalog.moves.map((move) => [move.id, move.name])),
    counts = Object.fromEntries(
      Object.keys(categoryLabels).map((c) => [
        c,
        living.filter((p) => p.analysis?.category === c).length,
      ]),
    );
  const reviewRows = living.filter((p) => p.analysis?.category === "review");
  const reviewUnverified = reviewRows.filter((p) => !p.verified).length;
  const reviewAnalysisLimited = reviewRows.length - reviewUnverified;
  const list = state.pokemon
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
  const pokemonById = new Map(state.pokemon.map((p) => [p.id, p]));
  const retainedEvolutionBySpecies = new Map(
    state.pokemon
      .filter((p) => p.owned && p.analysis?.category === "evolve" && effective(p).speciesId)
      .map((p) => [effective(p).speciesId!, p]),
  );
  const retainedMaxBySpecies = new Map(
    state.pokemon
      .filter((p) =>
        p.owned && ["dynamax", "gigantamax"].includes(p.maxStatus || "") &&
        p.analysis?.reasons.includes("保留此物種的極巨化收藏代表") &&
        effective(p).speciesId,
      )
      .map((p) => [effective(p).speciesId!, p]),
  );
  const activeCheckedTransfers = checkedTransfers.filter((id) =>
    state.pokemon.some((p) => p.id === id && p.owned && p.analysis?.category === "transfer"),
  );
  const allVisibleChecked = visibleTransferIds.length > 0 &&
    visibleTransferIds.every((id) => activeCheckedTransfers.includes(id));
  const toggleTransfer = (id: string) => setCheckedTransfers((current) =>
    current.includes(id) ? current.filter((row) => row !== id) : [...current, id],
  );
  const chosen = selected ? state.pokemon.find((p) => p.id === selected) : null;
  const batch = phoneState?.batch;
  const batchResumableCount = batch ? resumableTransferIndexes(batch).length : 0;
  const batchSkippableIndex = batch ? skippableTransferIndex(batch) : null;
  const batchSkippablePokemon = batchSkippableIndex === null ? null :
    state.pokemon.find((pokemon) => pokemon.id === batch!.entries[batchSkippableIndex].pokemonId);
  const batchProcessed = batch?.entries.filter((entry) =>
    ["submitted", "confirmed", "skipped", "uncertain"].includes(entry.status),
  ).length || 0;
  const batchSkipped = batch?.entries.filter((entry) => entry.status === "skipped").length || 0;
  const batchActiveEntry = batch?.entries.find((entry) =>
    ["searching", "prepared", "sent", "unfavoriting"].includes(entry.status),
  );
  const batchActivePokemon = batchActiveEntry
    ? state.pokemon.find((p) => p.id === batchActiveEntry.pokemonId)
    : null;
  const batchActiveName = batchActivePokemon ? effective(batchActivePokemon).name : null;
  const batchActiveStage = batchActiveEntry?.status === "searching"
    ? "排除背卡、核對 CP"
    : batchActiveEntry?.status === "prepared"
      ? "準備放生"
      : batchActiveEntry?.status === "sent"
        ? "已送出指令"
        : batchActiveEntry?.status === "unfavoriting"
          ? "取消最愛"
          : null;
  const batchStatusLabel = batch?.status === "approved" ? "準備開始" :
    batch?.status === "running" ? "處理中" :
    batch?.status === "paused" ? "已暫停" :
    batch?.status === "completed" ? "已完成" :
    batch?.status === "stopped" ? "已停止" : "待確認";
  const showBatchToast = Boolean(
    tab === "results" && batch && dismissedBatchId !== batch.id &&
    (["approved", "running"].includes(batch.status) ||
      trackedBatchId === batch.id ||
      (batch.status === "paused" &&
        Date.now() - Date.parse(batch.updatedAt) < 30 * 60_000)),
  );
  const phoneStatus = !phoneState
    ? { tone: "off", label: "檢查中" }
    : !phoneState.worker
      ? { tone: "off", label: "服務未啟動" }
      : phoneState.worker.ready
        ? { tone: "ok", label: "已連線" }
        : { tone: "warn", label: "未連線" };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav aria-label="主要功能">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${tab === t.id ? "active" : ""}`}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => navigate(t.id)}
            >
              <t.icon size={18} />
              <span>{t.label}</span>
              {t.id === "results" && counts.review > 0 && (
                <span className="nav-count" title="待確認">
                  {counts.review}
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
            <dd className={state.apiConfigured ? "ok" : "warn"}>
              {state.apiConfigured ? "已設定" : "未設定"}
            </dd>
          </div>
        </dl>
      </aside>
      <div className="workspace">
        <main>
          {error && (
            <div className="alert error" role="alert">
              <CircleHelp size={17} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="關閉錯誤"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <h1>{tabs.find((t) => t.id === tab)?.label}</h1>
              {tab === "results" && <p>只和已掃描、仍持有的寶可夢比較。</p>}
            </div>
            <div className="page-actions">
              <button
                className="icon-button bordered"
                title="重新整理"
                aria-label="重新整理"
                onClick={() => void refresh()}
              >
                <RefreshCw size={16} />
              </button>
              {tab !== "iphone" && (
                <button
                  className="button primary"
                  onClick={() => navigate("iphone")}
                >
                  <Smartphone size={16} />
                  開始掃描
                </button>
              )}
            </div>
          </div>
          {tab !== "settings" && tab !== "iphone" && (
            <div className="stats-grid">
              {(
                Object.keys(categoryLabels) as (keyof typeof categoryLabels)[]
              ).map((category) => {
                const Icon = icons[category];
                return (
                  <button
                    key={category}
                    className={`stat-card ${category} ${tab === "results" && filter === category ? "active" : ""}`}
                    aria-pressed={tab === "results" && filter === category}
                    onClick={() => {
                      setTab("results");
                      setFilter(category);
                    }}
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
          )}
          {tab === "iphone" && (
            <div className="iphone-workspace">
              <section className="panel iphone-panel">
                <div className="panel-heading">
                  <div>
                    <h2>手機連線</h2>
                    <p>用 USB 連接並解鎖 iPhone，在 Pokémon GO 打開寶可夢盒子。</p>
                  </div>
                  <span className={`status-pill ${phoneStatus.tone}`}>
                    {phoneStatus.label}
                  </span>
                </div>
                <p className="iphone-status">
                  {phoneState?.worker
                    ? phoneState.worker.message
                    : "背景服務未啟動，請用 npm run dev 或 npm start 啟動。"}
                </p>
                <small className="muted">
                  {phoneState?.worker?.version
                    ? `iPhone Use ${phoneState.worker.version}`
                    : "首次使用需先完成 iPhone Use 的裝置信任、開發者模式與 WDA 簽名。"}
                </small>
                <div className="iphone-actions">
                  <button
                    className="button secondary"
                    disabled={!phoneState?.worker || !!busy}
                    onClick={() =>
                      void phoneAct("prepare-phone", async () => {
                        await api("iphone/prepare", "POST");
                        notify("正在檢查連線");
                      })
                    }
                  >
                    檢查連線
                  </button>
                  <a
                    className="text-link"
                    href="https://github.com/zhongerxin/iPhone-use#先在自己的-iphone-上安装并启动-wda"
                    target="_blank"
                    rel="noreferrer"
                  >
                    首次設定指引
                    <ArrowUpRight size={14} />
                  </a>
                </div>
              </section>
              <section className="panel iphone-panel">
                <div className="panel-heading">
                  <div>
                    <h2>掃描</h2>
                    <p>先截圖所有寶可夢，再統一辨識與分析。掃描不會放生任何寶可夢。</p>
                  </div>
                </div>
                <div className="segmented" role="radiogroup" aria-label="掃描範圍">
                  <label>
                    <input
                      type="radio"
                      name="scan-scope"
                      checked={scanScope === "results"}
                      onChange={() => setScanScope("results")}
                    />
                    目前搜尋結果
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="scan-scope"
                      checked={scanScope === "all"}
                      onChange={() => setScanScope("all")}
                    />
                    整個寶可夢盒子
                  </label>
                </div>
                <button
                  className="button primary"
                  disabled={
                    !phoneState?.worker ||
                    !state.apiConfigured ||
                    !!busy ||
                    ["queued", "running"].includes(
                      phoneState?.scan?.status || "",
                    ) ||
                    ["approved", "running"].includes(
                      phoneState?.batch?.status || "",
                    )
                  }
                  onClick={() =>
                    void phoneAct("start-phone", async () => {
                      await api("scans", "POST", { scope: scanScope });
                      notify("掃描已開始");
                    })
                  }
                >
                  開始掃描
                </button>
                {!state.apiConfigured && (
                  <p className="job-error">
                    請先到「設定」頁填入 API key。
                  </p>
                )}
              </section>
              {phoneState?.scan && (
                <section className="panel iphone-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>掃描進度</h2>
                      <p>{phoneState.scan.stage}</p>
                    </div>
                    <span className="subtle-tag">{scanStatusLabels[phoneState.scan.status]}</span>
                  </div>
                  <div className="iphone-metrics">
                    <strong>{phoneState.scan.scanned} 隻已截圖</strong>
                    <span>{phoneState.scan.analyzed ?? (phoneState.scan.phase ? 0 : phoneState.scan.scanned)} 隻已解析</span>
                    <span>
                      {phoneState.scan.expected === null
                        ? "總數待確認"
                        : `預計 ${phoneState.scan.expected} 隻`}
                    </span>
                    <span>{phoneState.scan.review} 隻待人工核對</span>
                    {phoneState.scan.timing && (
                      <>
                        <span>平均每隻（{phoneState.scan.timing.phase === "capture" ? "截圖" : "解析"}）：{duration(phoneState.scan.timing.averageMs)}</span>
                        <span>已用時間（含暫停）：{duration(phoneState.scan.timing.elapsedMs)}</span>
                        <span>預計剩餘（{phoneState.scan.timing.phase === "capture" ? "截圖" : "解析"}）：{
                          phoneState.scan.status === "paused" ? "暫停中" :
                          phoneState.scan.status === "completed" ? "已完成" :
                          phoneState.scan.status === "stopped" ? "已停止" :
                          phoneState.scan.timing.phase === "capture" && phoneState.scan.expected === null
                            ? "總數未知"
                            : duration(phoneState.scan.timing.remainingMs)
                        }</span>
                      </>
                    )}
                    {phoneState.scan.apiUsage.navigationRequests === undefined &&
                    phoneState.scan.apiUsage.dataRequests === undefined ? (
                      <span>
                        {phoneState.scan.apiUsage.requests} 次 AI 呼叫（舊紀錄未分項）
                      </span>
                    ) : (
                      <>
                        <span>{phoneState.scan.apiUsage.navigationRequests ?? 0} 次畫面判斷</span>
                        <span>{phoneState.scan.apiUsage.dataRequests ?? 0} 次資料辨識</span>
                      </>
                    )}
                  </div>
                  {phoneState.scan.timing && (
                    <p className="caption">剩餘時間依近期每隻速度估算，截圖與解析分階段計算；長時間暫停不列入平均。</p>
                  )}
                  <p className="muted">
                    範圍：
                    {phoneState.scan.scope === "all"
                      ? "整個盒子"
                      : "目前搜尋結果"}{" "}
                    · 排序：{phoneState.scan.sort || "未讀取"}
                  </p>
                  {phoneState.scan.error && (
                    <p className="job-error">{phoneState.scan.error}</p>
                  )}
                  {phoneState.scan.currentFrame && (
                    <img
                      className="iphone-frame"
                      src={`/api/frames/${phoneState.scan.currentFrame}`}
                      alt="目前掃描個體的來源畫面"
                    />
                  )}
                  <div className="iphone-actions">
                    {["queued", "running"].includes(phoneState.scan.status) && (
                      <button
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void phoneAct("pause-scan", async () => {
                            await api(
                              `scans/${phoneState.scan!.id}/control`,
                              "POST",
                              { action: "pause" },
                            );
                          })
                        }
                      >
                        暫停
                      </button>
                    )}
                    {phoneState.scan.status === "paused" && (
                      <button
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void phoneAct("resume-scan", async () => {
                            await api(
                              `scans/${phoneState.scan!.id}/control`,
                              "POST",
                              { action: "resume" },
                            );
                          })
                        }
                      >
                        {phoneState.scan.phase === "analysis" ? "繼續解析" : "繼續截圖"}
                      </button>
                    )}
                    {phoneState.scan.status === "paused" &&
                      phoneState.scan.phase !== "analysis" &&
                      phoneState.scan.expected === null &&
                      phoneState.scan.scanned > 0 && (
                        <button
                          className="button secondary"
                          disabled={!!busy}
                          onClick={() =>
                            void phoneAct("finish-capture", async () => {
                              await api(
                                `scans/${phoneState.scan!.id}/control`,
                                "POST",
                                { action: "finish" },
                              );
                              notify("開始解析");
                            })
                          }
                        >
                          確認已到列表終點並開始解析
                        </button>
                      )}
                    {["queued", "running", "paused"].includes(
                      phoneState.scan.status,
                    ) && (
                      <button
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void phoneAct("stop-scan", async () => {
                            await api(
                              `scans/${phoneState.scan!.id}/control`,
                              "POST",
                              { action: "stop" },
                            );
                          })
                        }
                      >
                        停止
                      </button>
                    )}
                    {["paused", "stopped", "failed"].includes(
                      phoneState.scan.status,
                    ) && (
                      <button
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void phoneAct("discard-scans", async () => {
                            const result = await api<{
                              discardedScans: number;
                              discardedPokemon: number;
                              frameCleanupFailed: number;
                            }>("scans/discard", "POST");
                            setScanScope(phoneState.scan!.scope);
                            notify(
                              `已清除 ${result.discardedScans} 筆未完成掃描及 ${result.discardedPokemon} 隻相關個體；請按「開始掃描」重來${result.frameCleanupFailed ? `。${result.frameCleanupFailed} 筆截圖未能清除` : ""}`,
                            );
                          })
                        }
                      >
                        <Trash2 size={15} />
                        清除未完成掃描並重來
                      </button>
                    )}
                  </div>
                  {["paused", "stopped", "failed"].includes(
                    phoneState.scan.status,
                  ) && (
                    <p className="muted">
                      清除後請在遊戲返回寶可夢盒子列表，再按上方「開始掃描」。
                    </p>
                  )}
                </section>
              )}

            </div>
          )}
          {(tab === "results" || tab === "collection") && (
            <>
              {tab === "results" && batch && (
                <section className="panel iphone-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>放生進度</h2>
                      <p>特殊背卡或無法確認身分的寶可夢會自動跳過。</p>
                    </div>
                    <span className="subtle-tag">{batchStatusLabel}</span>
                  </div>
                  <p className="muted">
                    已處理 {batchProcessed} / {batch.entries.length} 隻 · 跳過 {batchSkipped} 隻
                  </p>
                  <p className="muted">
                    手機搜尋排除：{(batch.searchExclusions || defaultTransferSearchFilters)
                      .map((id) => transferSearchFilters.find((option) => option.id === id)?.label)
                      .filter(Boolean).join("、") || "未選"}
                  </p>
                  {batch.error && <p className="job-error">{batch.error}</p>}
                  {batchResumableCount > 0 && (
                    <p className="muted">先在手機返回寶可夢盒子列表，再按「繼續」；已送出的個體不會重送。</p>
                  )}
                  {batchSkippableIndex !== null && (
                    <p className="muted">
                      可跳過 {batchSkippablePokemon ? `${effective(batchSkippablePokemon).name || "這隻寶可夢"} · CP ${effective(batchSkippablePokemon).cp ?? "?"}` : "這隻寶可夢"}；它會維持持有，不會再由此批次放生。
                    </p>
                  )}
                  <details>
                    <summary>查看逐隻紀錄</summary>
                    <div className="iphone-candidates">
                      {batch.entries.map((entry, index) => {
                        const pokemon = state.pokemon.find((row) => row.id === entry.pokemonId);
                        if (!pokemon) return null;
                        const f = effective(pokemon);
                        return (
                          <div className="iphone-candidate" key={`${entry.pokemonId}-${index}`}>
                            {pokemon.sources[0]?.frame && (
                              <img
                                src={`/api/frames/${pokemon.sources[0].frame}`}
                                alt={`${f.name || "寶可夢"}來源畫面`}
                              />
                            )}
                            <div>
                              <strong>{displayPokemonName(f.name || f.speciesId || "寶可夢", f.costume, f.speciesId)} · CP {f.cp ?? "?"}</strong>
                              <small>{entryStatusLabels[entry.status]}</small>
                              {entry.reason && <small>{entry.reason}</small>}
                            </div>
                            <button className="button small secondary" onClick={() => setSelected(pokemon.id)}>
                              查看來源
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                  {batchSkippableIndex !== null && (
                    <button
                      className="button secondary"
                      disabled={!!busy}
                      onClick={() => skipTransferEntry(batch)}
                    >
                      跳過這隻並繼續
                    </button>
                  )}
                  {batchResumableCount > 0 && (
                    <button
                      className="button"
                      disabled={!!busy}
                      onClick={() => void phoneAct("resume-transfer", async () => {
                        const resumed = await api<TransferBatch>(`transfers/${batch.id}/resume`, "POST");
                        setTrackedBatchId(resumed.id);
                        setDismissedBatchId(null);
                        notify(`繼續放生剩餘 ${batchResumableCount} 隻`);
                      })}
                    >
                      繼續放生剩餘 {batchResumableCount} 隻
                    </button>
                  )}
                  {["approved", "running", "paused"].includes(batch.status) && (
                    <button
                      className="button secondary"
                      disabled={!!busy}
                      onClick={() => void phoneAct("stop-transfer", async () => {
                        await api(`transfers/${batch.id}/stop`, "POST");
                      })}
                    >
                      停止批次
                    </button>
                  )}
                </section>
              )}
              {tab === "results" && phoneState?.resumableBatches?.some((row) => row.id !== batch?.id) && (
                <section className="panel iphone-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>先前暫停的放生</h2>
                      <p>可繼續原批次中尚未送出的個體，無須重新勾選。</p>
                    </div>
                  </div>
                  {phoneState.resumableBatches.filter((row) => row.id !== batch?.id).map((row) => (
                    <div className="iphone-candidate" key={row.id}>
                      <span>已處理 {row.entries.filter((entry) => ["submitted", "confirmed", "skipped", "uncertain"].includes(entry.status)).length}/{row.entries.length} · {row.resumeBlocked || row.error}</span>
                      {skippableTransferIndex(row) !== null && (
                        <button
                          className="button small secondary"
                          disabled={!!busy || !!row.resumeBlocked || ["approved", "running"].includes(batch?.status || "")}
                          onClick={() => skipTransferEntry(row)}
                        >
                          跳過這隻並繼續
                        </button>
                      )}
                      <button
                        className="button small"
                        disabled={!!busy || !!row.resumeBlocked || ["approved", "running"].includes(batch?.status || "")}
                        onClick={() => void phoneAct("resume-transfer", async () => {
                          const resumed = await api<TransferBatch>(`transfers/${row.id}/resume`, "POST");
                          setTrackedBatchId(resumed.id);
                          setDismissedBatchId(null);
                          notify(`繼續放生剩餘 ${resumableTransferIndexes(row).length} 隻`);
                        })}
                      >
                        繼續放生剩餘 {resumableTransferIndexes(row).length} 隻
                      </button>
                    </div>
                  ))}
                </section>
              )}
              <div className="panel results-panel">
                <div className="results-toolbar">
                  <div className="filter-tabs">
                    {["all", ...Object.keys(categoryLabels)].map((c) => (
                      <button
                        key={c}
                        className={filter === c ? "active" : ""}
                        onClick={() => setFilter(c)}
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
                    onClick={() =>
                      void act("evaluate", async () => {
                        await api("reevaluate", "POST");
                        notify("已重新計算建議");
                      })
                    }
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
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜尋名稱、造型、全國圖鑑編號或 CP"
                    />
                  </label>
                  <div className="list-controls">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={showArchived}
                        onChange={(e) => setShowArchived(e.target.checked)}
                      />
                      顯示已放生
                    </label>
                    <select
                      aria-label="排序方式"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
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
                {tab === "results" && (
                  <div className="transfer-search-options">
                    <strong>放生時手機搜尋排除</strong>
                    <div className="transfer-search-checks">
                      {transferSearchFilters.map((option) => (
                        <label key={option.id} className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={searchExclusions.includes(option.id)}
                            disabled={!!busy || ["approved", "running"].includes(batch?.status || "") ||
                              (option.id !== "background" && !searchExclusions.includes(option.id) &&
                                searchExclusions.filter((id) => id !== "background").length >= maxExtraTransferSearchFilters)}
                            onChange={() => toggleSearchExclusion(option.id)}
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                    <small>額外最多選兩項，避免手機搜尋字串超出可核對範圍。未勾背卡時仍會另行檢查並跳過背卡個體。</small>
                    <code>範例：{transferSearchQuery(25, searchExclusions)}</code>
                  </div>
                )}
                {tab === "results" && (
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
                        ["approved", "running"].includes(phoneState?.batch?.status || "")
                      }
                      onClick={() => startSelectedTransfers(activeCheckedTransfers)}
                    >
                      放生勾選的 {activeCheckedTransfers.length} 隻
                    </button>
                  </div>
                )}
                {list.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {tab === "results" && (
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
                          )}
                          <th>寶可夢</th>
                          <th>CP / IV</th>
                          <th>建議分類</th>
                          <th>判斷依據</th>
                          <th>核對</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((p) => {
                          const f = effective(p);
                          const name = displayPokemonName(
                            f.name || catalog.species.find((s) => s.id === f.speciesId)?.name || "待辨識個體",
                            f.costume,
                            f.speciesId,
                          );
                          const retainedEvolution = p.analysis?.category === "transfer" && f.speciesId
                            ? (p.analysis.comparedWith
                                .map((id) => pokemonById.get(id))
                                .find((peer) =>
                                  peer?.owned && peer.analysis?.category === "evolve" &&
                                  effective(peer).speciesId === f.speciesId,
                                ) || retainedEvolutionBySpecies.get(f.speciesId))
                            : null;
                          const retainedMax = p.analysis?.category === "transfer" &&
                            ["dynamax", "gigantamax"].includes(p.maxStatus || "") && f.speciesId
                              ? retainedMaxBySpecies.get(f.speciesId)
                              : null;
                          return (
                            <tr
                              key={p.id}
                              onClick={() => setSelected(p.id)}
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") setSelected(p.id);
                              }}
                            >
                              {tab === "results" && (
                                <td className="transfer-check-cell">
                                  {p.owned && p.analysis?.category === "transfer" && (
                                    <input
                                      type="checkbox"
                                      aria-label={`勾選 ${name} CP ${f.cp ?? "未知"}`}
                                      checked={activeCheckedTransfers.includes(p.id)}
                                      onClick={(event) => event.stopPropagation()}
                                      onKeyDown={(event) => event.stopPropagation()}
                                      onChange={() => toggleTransfer(p.id)}
                                    />
                                  )}
                                </td>
                              )}
                              <td>
                                <div className="pokemon-cell">
                                  <PokemonSprite pokemon={p} />
                                  <div>
                                    <strong>
                                      <span className="pokemon-display-name">{name}</span>
                                      {f.shiny && <Sparkles size={12} />}
                                      {p.maxStatus === "dynamax" && " · 極巨化"}
                                      {p.maxStatus === "gigantamax" && " · 超極巨化"}
                                      {f.favorite === true && (
                                        <span className="favorite-label" title="遊戲內最愛">
                                          <Star size={12} fill="currentColor" />
                                          最愛
                                        </span>
                                      )}
                                    </strong>
                                    <small>
                                      {speciesLabel(catalog, f.speciesId, f.name)}
                                      {!p.owned ? " · 已放生" : ""}
                                    </small>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <strong className="cp-value">
                                  {f.cp ?? "—"}
                                </strong>
                                <div className="iv-values">
                                  {[f.ivAtk, f.ivDef, f.ivSta].map((v, i) => (
                                    <span
                                      className={v === 15 ? "perfect" : ""}
                                      key={i}
                                    >
                                      {v ?? "?"}
                                    </span>
                                  ))}
                                </div>
                              </td>
                              <td>
                                <Status
                                  category={p.analysis?.category || "review"}
                                />
                                {retainedEvolution && (
                                  <button
                                    className="retained-evolution-link"
                                    title="查看已保留的可進化個體"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSelected(retainedEvolution.id);
                                    }}
                                    onKeyDown={(event) => event.stopPropagation()}
                                  >
                                    已保留 1 隻可進化（CP {effective(retainedEvolution).cp ?? "?"}）
                                  </button>
                                )}
                                {retainedMax && retainedMax.id !== p.id && (
                                  <button
                                    className="retained-evolution-link"
                                    title="查看已保留的極巨化個體"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSelected(retainedMax.id);
                                    }}
                                    onKeyDown={(event) => event.stopPropagation()}
                                  >
                                    已保留 1 隻極巨化（CP {effective(retainedMax).cp ?? "?"}）
                                  </button>
                                )}
                              </td>
                              <td className="reason-cell">
                                {localizeSpeciesName(localizeMoveText(p.analysis?.reasons[0] || "等待分析", moveNames))}
                                <small>{p.sources.length} 張來源畫面</small>
                              </td>
                              <td>
                                <span
                                  className={`verification ${p.verified ? "done" : ""}`}
                                >
                                  {p.verified ? (
                                    <CheckCircle2 size={13} />
                                  ) : (
                                    <CircleHelp size={13} />
                                  )}{" "}
                                  {p.verified ? "已核對" : "待核對"}
                                </span>
                              </td>
                              <td>
                                <ChevronRight size={17} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="large-empty">
                    <div>
                      <FolderHeart size={32} strokeWidth={1.3} />
                    </div>
                    <h3>
                      {state.pokemon.length
                        ? "沒有符合條件的寶可夢"
                        : "還沒有掃描資料"}
                    </h3>
                    <p>
                      {state.pokemon.length
                        ? "換個分類或搜尋條件試試。"
                        : "用 iPhone 掃描後，結果會列在這裡。"}
                    </p>
                    {!state.pokemon.length && (
                      <button
                        className="button primary"
                        onClick={() => navigate("iphone")}
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
            </>
          )}
          {tab === "settings" && (
            <SettingsView
              state={state}
              onAction={act}
              onRefreshCatalog={loadCatalog}
              onToast={notify}
              backupInput={backupInput}
              busy={busy}
            />
          )}
          <footer className="page-footer">
            <span>
              {state.snapshot
                ? `遊戲資料 ${state.snapshot.sourceDate.split(" ")[0]} · ${number(state.snapshot.count)} 種物種／形態`
                : "尚未載入遊戲資料"}
              <span className="footer-dot">·</span>Pokéep v0.1
            </span>
          </footer>
        </main>
      </div>
      {showBatchToast && batch && (
        <div className="toast transfer-progress-toast" role="status" aria-live="polite">
          <span>
            放生{batchStatusLabel} · 已處理 {batchProcessed}/{batch.entries.length}
            {batchSkipped ? ` · 跳過 ${batchSkipped}` : ""}
            {batchActiveName ? ` · 目前 ${batchActiveName}${batchActiveStage ? `：${batchActiveStage}` : ""}` : ""}
            {batch.error ? ` · ${batch.error}` : ""}
          </span>
          {["approved", "running"].includes(batch.status) ? (
            <button
              className="transfer-toast-button"
              disabled={!!busy}
              onClick={() => void phoneAct("stop-transfer", async () => {
                await api(`transfers/${batch.id}/stop`, "POST");
              })}
            >
              停止
            </button>
          ) : batchResumableCount > 0 ? (
            <>
              {batchSkippableIndex !== null && (
                <button
                  className="transfer-toast-button"
                  disabled={!!busy}
                  onClick={() => skipTransferEntry(batch)}
                >
                  跳過這隻並繼續
                </button>
              )}
              <button
                className="transfer-toast-button"
                disabled={!!busy}
                onClick={() => void phoneAct("resume-transfer", async () => {
                  const resumed = await api<TransferBatch>(`transfers/${batch.id}/resume`, "POST");
                  setTrackedBatchId(resumed.id);
                  setDismissedBatchId(null);
                })}
              >
                繼續
              </button>
            </>
          ) : (
            <button className="transfer-toast-button" onClick={() => setDismissedBatchId(batch.id)}>
              關閉
            </button>
          )}
        </div>
      )}
      {toast && (
        <div className={`toast ${showBatchToast ? "toast-stacked" : ""}`} role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {chosen && (
        <PokemonDrawer
          key={chosen.id}
          pokemon={chosen}
          records={state.pokemon}
          catalog={catalog}
          error={error}
          onClose={closeDrawer}
          onSave={async (data) => {
            await act("save", async () => {
              await api(`pokemon/${chosen.id}`, "PATCH", data);
              notify("已儲存並重新評估");
            });
          }}
          onMerge={async (source) => {
            await act("merge", async () => {
              await api("merge", "POST", { target: chosen.id, source });
              notify("已合併，請重新核對欄位");
            });
          }}
          busy={!!busy}
        />
      )}
    </div>
  );
}
function SettingsView({
  state,
  onAction,
  onRefreshCatalog,
  onToast,
  backupInput,
  busy,
}: {
  state: State;
  onAction: (label: string, fn: () => Promise<void>) => Promise<void>;
  onRefreshCatalog: () => Promise<void>;
  onToast: (text: string) => void;
  backupInput: React.RefObject<HTMLInputElement | null>;
  busy: string;
}) {
  const [preferences, setPreferences] = useState(state.settings);
  const [runtime, setRuntime] = useState(state.runtime);
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [showClearPokemon, setShowClearPokemon] = useState(false);
  const [clearConfirmation, setClearConfirmation] = useState("");
  useEffect(
    () => setPreferences(state.settings),
    [
      state.settings.raidSlots,
      state.settings.metaCutoff,
      state.settings.ivCutoff,
      state.settings.rareRepresentatives,
    ],
  );
  useEffect(() => setRuntime(state.runtime), [
    state.runtime.apiConfigured,
    state.runtime.model,
    state.runtime.baseUrl,
    state.runtime.analysisConcurrency,
    state.runtime.shinyReviewConcurrency,
    state.runtime.iphoneUseRoot,
    state.runtime.iphoneUsePython,
  ]);
  return (
    <div className="settings-grid">
      <section className="panel settings-card">
        <h2>AI 辨識（OpenAI）</h2>
        <div
          className={`connection-state ${state.apiConfigured ? "connected" : ""}`}
        >
          <span className="online-dot" />
          {state.apiConfigured ? "API key 已設定" : "尚未設定 API key"}
          <small>{state.model}</small>
        </div>
        <div className="preference-fields">
          <label>
            <span>API key（留空保留已設定的 key）</span>
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              placeholder={state.apiConfigured ? "已設定" : "輸入 API key"}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={clearApiKey}
            />
          </label>
          {state.apiConfigured && (
            <label className="settings-check">
              <input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} />
              <span>清除已儲存的 API key</span>
            </label>
          )}
          <label>
            <span>模型</span>
            <input value={runtime.model} onChange={(event) => setRuntime((value) => ({ ...value, model: event.target.value }))} />
          </label>
          <label>
            <span>AI 伺服器網址（留空使用 OpenAI）</span>
            <input type="url" value={runtime.baseUrl} placeholder="http://127.0.0.1:1234/v1" onChange={(event) => setRuntime((value) => ({ ...value, baseUrl: event.target.value }))} />
          </label>
          <label>
            <span>一般解析並行數（1–8）</span>
            <input type="number" min={1} max={8} value={runtime.analysisConcurrency} onChange={(event) => setRuntime((value) => ({ ...value, analysisConcurrency: Number(event.target.value) }))} />
          </label>
          <label>
            <span>色違複核並行數（1–8）</span>
            <input type="number" min={1} max={8} value={runtime.shinyReviewConcurrency} onChange={(event) => setRuntime((value) => ({ ...value, shinyReviewConcurrency: Number(event.target.value) }))} />
          </label>
        </div>
        <p className="caption">設定儲存在這台 Mac，不會放進匯出的備份。API 依用量計費。</p>
        <a
          className="text-link"
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noreferrer"
        >
          管理 OpenAI API keys
          <ArrowUpRight size={14} />
        </a>
        <h3>iPhone Use</h3>
        <div className="preference-fields">
          <label>
            <span>專案位置</span>
            <input value={runtime.iphoneUseRoot} onChange={(event) => setRuntime((value) => ({ ...value, iphoneUseRoot: event.target.value }))} />
          </label>
          <label>
            <span>Python 指令或執行檔</span>
            <input value={runtime.iphoneUsePython} onChange={(event) => setRuntime((value) => ({ ...value, iphoneUsePython: event.target.value }))} />
          </label>
        </div>
        <button className="button primary" disabled={!!busy} onClick={() => void onAction("runtime-settings", async () => {
          await api("runtime-settings", "PATCH", {
            model: runtime.model,
            baseUrl: runtime.baseUrl,
            analysisConcurrency: runtime.analysisConcurrency,
            shinyReviewConcurrency: runtime.shinyReviewConcurrency,
            iphoneUseRoot: runtime.iphoneUseRoot,
            iphoneUsePython: runtime.iphoneUsePython,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            ...(clearApiKey ? { clearApiKey: true } : {}),
          });
          setApiKey("");
          setClearApiKey(false);
          onToast("連線與解析設定已儲存");
        })}>
          <Check size={15} />儲存連線與解析設定
        </button>
      </section>
      <section className="panel settings-card">
        <h2>遊戲資料</h2>
        <p>更新後會重新評估收藏；失敗時保留舊版本。</p>
        {state.snapshot ? (
          <div className="snapshot-details">
            <div>
              <span>資料日期（PvPoke）</span>
              <strong>{state.snapshot.sourceDate}</strong>
            </div>
            <div>
              <span>更新時間</span>
              <strong>{date(state.snapshot.updatedAt)}</strong>
            </div>
            <div>
              <span>物種／形態</span>
              <strong>{number(state.snapshot.count)}</strong>
            </div>
            <div>
              <span>快照版本</span>
              <code>{state.snapshot.version}</code>
            </div>
          </div>
        ) : (
          <div className="alert">尚未載入資料，請先更新。</div>
        )}
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() =>
            void onAction("data", async () => {
              await api("data/update", "POST");
              await onRefreshCatalog();
              onToast("遊戲資料已更新，收藏庫已重新評估");
            })
          }
        >
          {busy === "data" ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}
          更新遊戲資料
        </button>
        <details className="source-details">
          <summary>
            查看資料來源與計算限制
            <ChevronDown size={14} />
          </summary>
          {state.snapshot?.sources.map((s) => (
            <a key={s.name} href={s.url} target="_blank" rel="noreferrer">
              {s.name}
              <ArrowUpRight size={12} />
            </a>
          ))}
          {state.snapshot?.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <p>
            PvP IV 排名為 4,096 組合、等級上限 50。團體戰採固定防禦 150
            的中性循環 DPS，無天氣、好友或來襲傷害充能。
          </p>
        </details>
      </section>
      <section className="panel settings-card">
        <h2>清倉規則</h2>
        <div className="preference-fields">
          {(
            [
              { key: "raidSlots", label: "每種攻擊屬性保留名額（12 隻可留二軍）", max: 24 },
              { key: "metaCutoff", label: "PvP 環境排名門檻", max: 300 },
              { key: "ivCutoff", label: "PvP 個體 IV 排名門檻", max: 4096 },
              {
                key: "rareRepresentatives",
                label: "每種特殊收藏保留代表數",
                max: 10,
              },
            ] as const
          ).map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input
                type="number"
                min={1}
                max={f.max}
                value={preferences[f.key]}
                onChange={(e) =>
                  setPreferences((p) => ({
                    ...p,
                    [f.key]: Number(e.target.value),
                  }))
                }
              />
            </label>
          ))}
        </div>
        <button
          className="button primary"
          disabled={!!busy}
          onClick={() =>
            void onAction("preferences", async () => {
              await api("settings", "PATCH", preferences);
              onToast("偏好已儲存，已重新評估");
            })
          }
        >
          <Check size={15} />
          儲存並重新評估
        </button>
      </section>
      <section className="panel settings-card">
        <h2>備份與還原</h2>
        <p>JSON 備份包含寶可夢紀錄、人工修正、遊戲資料、掃描紀錄與截圖，不含 API key。</p>
        <div className="storage-summary">
          <strong>{state.pokemon.length}</strong>
          <span>筆寶可夢紀錄</span>
        </div>
        <div className="button-row">
          <a className="button secondary" href="/api/export">
            <ArrowDownToLine size={15} />
            匯出 JSON 備份
          </a>
          <a className="button secondary" href="/api/export?format=csv">
            <ArrowDownToLine size={15} />
            匯出 CSV
          </a>
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => backupInput.current?.click()}
          >
            <Upload size={15} />
            匯入 JSON 備份
          </button>
        </div>
        <input
          ref={backupInput}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              void onAction("restore", async () => {
                if (file.size > 150 * 1024 * 1024)
                  throw new Error("備份上限為 150 MB");
                const result = await api<{ imported: number; skipped: number }>(
                  "import",
                  "POST",
                  JSON.parse(await file.text()),
                );
                await onRefreshCatalog();
                onToast(
                  `已還原 ${result.imported} 隻，略過 ${result.skipped} 筆既有紀錄`,
                );
              });
            e.target.value = "";
          }}
        />
        <p className="caption">匯入時不會覆蓋既有紀錄與人工修正。</p>
      </section>
      <section className="panel settings-card">
        <h2>清除寶可夢資料</h2>
        <p>清除全部寶可夢、掃描截圖、辨識快取及放生紀錄。連線設定、清倉規則和遊戲資料會保留。此操作無法復原，建議先匯出備份。</p>
        {!showClearPokemon ? (
          <button className="button danger-outline" disabled={!!busy} onClick={() => setShowClearPokemon(true)}>
            <Trash2 size={15} />清除所有寶可夢資料
          </button>
        ) : (
          <div className="preference-fields">
            <label>
              <span>輸入「清除全部寶可夢」以確認</span>
              <input value={clearConfirmation} autoComplete="off" onChange={(event) => setClearConfirmation(event.target.value)} />
            </label>
            <div className="button-row">
              <button className="button secondary" disabled={!!busy} onClick={() => {
                setShowClearPokemon(false);
                setClearConfirmation("");
              }}>取消</button>
              <button className="button danger" disabled={!!busy || clearConfirmation !== "清除全部寶可夢"} onClick={() => void onAction("clear-pokemon", async () => {
                const result = await api<{ removedPokemon: number }>("pokemon/clear-all", "POST", { confirmation: clearConfirmation });
                setShowClearPokemon(false);
                setClearConfirmation("");
                onToast(`已清除 ${result.removedPokemon} 筆寶可夢資料`);
              })}>
                <Trash2 size={15} />確認清除
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function PokemonDrawer({
  pokemon: p,
  records,
  catalog,
  error,
  onClose,
  onSave,
  onMerge,
  busy,
}: {
  pokemon: Pokemon;
  records: Pokemon[];
  catalog: Catalog;
  error: string;
  onClose: () => void;
  onSave: (data: unknown) => Promise<void>;
  onMerge: (id: string) => Promise<void>;
  busy: boolean;
}) {
  const [section, setSection] = useState("review"),
    [fields, setFields] = useState<Fields>(effective(p)),
    [speciesQuery, setSpeciesQuery] = useState(""),
    [source, setSource] = useState(0),
    [verified, setVerified] = useState(p.verified),
    [evolutionSilhouette, setEvolutionSilhouette] = useState<boolean | "unavailable" | "unknown-branch" | null>(
      p.evolutionSilhouette ?? null,
    ),
    [maxStatus, setMaxStatus] = useState<Pokemon["maxStatus"]>(
      p.maxStatus ?? null,
    ),
    [dismiss, setDismiss] = useState(false),
    [proofError, setProofError] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null),
    panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setFields(effective(p));
    setSpeciesQuery("");
    setVerified(p.verified);
    setEvolutionSilhouette(p.evolutionSilhouette ?? null);
    setMaxStatus(p.maxStatus ?? null);
    setDismiss(false);
  }, [p.id, p.updatedAt, p.verified, p.locked, p.owned]);
  useEffect(() => {
    setProofError(false);
  }, [source]);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const elements = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]',
          ) || [],
        );
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", key);
      old?.focus();
    };
  }, [onClose]);
  const a = p.analysis,
    activeSource = p.sources[Math.min(source, p.sources.length - 1)],
    moveNames = Object.fromEntries(catalog.moves.map((move) => [move.id, move.name]));
  const changes = Object.fromEntries(
    (Object.keys(fields) as (keyof Fields)[])
      .filter((key) => fields[key] !== effective(p)[key])
      .map((key) => [key, fields[key]]),
  );
  const set = (key: keyof Fields, value: Fields[keyof Fields]) => {
    setFields((f) => ({ ...f, [key]: value }));
    setVerified(false);
  };
  const sourceFor = (key: keyof Fields) =>
    p.sources.filter((s) => s.fields.includes(key));
  const editor = (key: keyof Fields) => {
    const bool = ["shadow", "purified", "shiny", "favorite"].includes(key),
      text = ["name", "form", "costume"].includes(key),
      moves = ["fastMove", "chargeMove", "chargeMove2"].includes(key);
    if (key === "speciesId") {
      const query = speciesQuery.trim().replace(/^#/, "").toLocaleLowerCase();
      const matches = catalog.species.filter((s) =>
        !query || String(s.dex).includes(query) ||
        s.name.toLocaleLowerCase().includes(query) ||
        localizeSpeciesName(s.name, s.id).toLocaleLowerCase().includes(query) ||
        s.id.toLocaleLowerCase().includes(query));
      const options = fields.speciesId && !matches.some((s) => s.id === fields.speciesId)
        ? [...catalog.species.filter((s) => s.id === fields.speciesId), ...matches]
        : matches;
      return (
        <div className="edit-field" key={key}>
          <span>
            {fieldLabels[key]}
            {Object.hasOwn(p.overrides, key) && <small>已修正</small>}
          </span>
          <input
            aria-label="搜尋物種"
            value={speciesQuery}
            placeholder="搜尋中文名稱、圖鑑編號或英文 ID"
            onChange={(e) => setSpeciesQuery(e.target.value)}
          />
          <select
            aria-label="物種／形態"
            value={fields.speciesId || ""}
            onChange={(e) => {
              const s = catalog.species.find((row) => row.id === e.target.value);
              setFields((f) => ({
                ...f,
                speciesId: e.target.value || null,
                ...(s ? {
                  shadow: s.id.endsWith("_shadow"),
                  name: f.name || s.name.split(" ")[0],
                } : {}),
              }));
              setVerified(false);
            }}
          >
            <option value="">選擇物種／形態</option>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.dex} {localizeSpeciesName(s.name, s.id)}
              </option>
            ))}
          </select>
          <small>{query ? `找到 ${matches.length} 種物種／形態` :
            `${catalog.species.length} 種物種／形態`}</small>
        </div>
      );
    }
    return (
      <label className="edit-field" key={key}>
        <span>
          {fieldLabels[key]}
          {Object.hasOwn(p.overrides, key) && <small>已修正</small>}
        </span>
        {bool ? (
          <select
            value={fields[key] === null ? "" : String(fields[key])}
            onChange={(e) =>
              set(key, e.target.value === "" ? null : e.target.value === "true")
            }
          >
            <option value="">未知</option>
            <option value="true">是</option>
            <option value="false">否</option>
          </select>
        ) : key === "gender" ? (
          <select
            value={fields.gender || ""}
            onChange={(e) =>
              set(key, (e.target.value as Fields["gender"]) || null)
            }
          >
            <option value="">未知</option>
            <option value="male">雄性</option>
            <option value="female">雌性</option>
            <option value="genderless">無性別</option>
          </select>
        ) : moves ? (
          <>
            <input
              list="move-options"
              value={fields[key] ? moveName(String(fields[key]), moveNames) : ""}
              placeholder="未顯示／未知"
              onChange={(e) => set(key, e.target.value || null)}
            />
          </>
        ) : (
          <input
            type={text ? "text" : "number"}
            step={["height", "weight"].includes(key) ? "0.01" : "1"}
            min={0}
            max={key.startsWith("iv") ? 15 : undefined}
            value={String(fields[key] ?? "")}
            placeholder="未知"
            onChange={(e) =>
              set(
                key,
                e.target.value === ""
                  ? null
                  : text
                    ? e.target.value
                    : Number(e.target.value),
              )
            }
          />
        )}
        <small>
          {sourceFor(key).length
            ? `${sourceFor(key).length} 張畫面可核對`
            : Object.hasOwn(p.overrides, key)
              ? "人工補充"
              : "來源未顯示"}
        </small>
      </label>
    );
  };
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
      >
        <div className="drawer-heading">
          <div>
            <h2 id="drawer-title">
              {displayPokemonName(fields.name || "待辨識個體", fields.costume, fields.speciesId)}
              <Status category={a?.category || "review"} />
            </h2>
            <p>
              {speciesLabel(catalog, fields.speciesId, fields.name)} · {p.sources.length}{" "}
              張來源畫面
            </p>
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            aria-label="關閉個體詳情"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </div>
        <div className="drawer-tabs">
          {[
            { id: "review", label: "辨識核對" },
            { id: "analysis", label: "分析建議" },
            { id: "sources", label: "來源證據" },
          ].map((t) => (
            <button
              className={section === t.id ? "active" : ""}
              key={t.id}
              onClick={() => setSection(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="drawer-scroll">
          {error && (
            <div className="alert error" role="alert">
              <CircleHelp size={16} />
              <span>{error}</span>
            </div>
          )}
          {section === "review" && (
            <>
              {p.issues.length > 0 && (
                <details className="review-issues" open>
                  <summary>
                    <CircleHelp size={15} />
                    需要你確認的資訊（{p.issues.length}）
                  </summary>
                  <ul>
                    {p.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </details>
              )}
              {p.candidates.length > 0 && (
                <div className="candidate-box">
                  <h3>疑似同一隻寶可夢</h3>
                  <p>核對來源後再合併；如果確定是不同個體，請勾選下方選項。</p>
                  {p.candidates.map((candidate) => {
                    const peer = records.find((r) => r.id === candidate);
                    if (!peer) return null;
                    const f = effective(peer);
                    return (
                      <div key={candidate}>
                        <span>
                          {f.name || "未辨識"} · CP {f.cp ?? "?"} ·{" "}
                          {peer.sources.length} 張來源
                        </span>
                        <button
                          className="button small secondary"
                          disabled={busy}
                          onClick={() => void onMerge(candidate)}
                        >
                          合併至此個體
                        </button>
                      </div>
                    );
                  })}
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={dismiss}
                      onChange={(e) => setDismiss(e.target.checked)}
                    />
                    我確認這些是不同個體，解除疑似配對
                  </label>
                </div>
              )}
              <div className="review-layout">
                <div className="review-proof">
                  {activeSource && !proofError ? (
                    <img
                      src={`/api/frames/${activeSource.frame}`}
                      alt={`${sourceName(activeSource)} ${sourceTime(activeSource)} 來源截圖`}
                      onError={() => setProofError(true)}
                    />
                  ) : (
                    <div className="missing-proof">
                      <Film size={28} />
                      來源截圖不存在
                    </div>
                  )}
                  {activeSource && (
                    <div>
                      <strong>{sourceTime(activeSource)}</strong>
                      <small>{sourceName(activeSource)}</small>
                      <button
                        className="text-button"
                        onClick={() => setSection("sources")}
                      >
                        查看所有來源
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="edit-fields">
                  <h3>基本資訊</h3>
                  {(
                    [
                      "name",
                      "speciesId",
                      "form",
                      "cp",
                      "hp",
                      "gender",
                      "height",
                      "weight",
                    ] as (keyof Fields)[]
                  ).map(editor)}
                  <h3>收藏與個體能力</h3>
                  {(
                    [
                      "shadow",
                      "purified",
                      "shiny",
                      "costume",
                      "favorite",
                      "ivAtk",
                      "ivDef",
                      "ivSta",
                    ] as (keyof Fields)[]
                  ).map(editor)}
                  <h3>目前招式</h3>
                  {(
                    [
                      "fastMove",
                      "chargeMove",
                      "chargeMove2",
                    ] as (keyof Fields)[]
                  ).map(editor)}
                  <label className="edit-field">
                    <span>進化按鈕狀態</span>
                    <select
                      value={
                        evolutionSilhouette === null
                          ? ""
                          : String(evolutionSilhouette)
                      }
                      onChange={(event) =>
                        setEvolutionSilhouette(
                          event.target.value === ""
                            ? null
                            : event.target.value === "unavailable"
                              ? "unavailable"
                              : event.target.value === "unknown-branch"
                                ? "unknown-branch"
                                : event.target.value === "true",
                        )
                      }
                    >
                      <option value="">未能確認</option>
                      <option value="true">未登錄剪影</option>
                      <option value="false">已登錄彩色圖示</option>
                      <option value="unknown-branch">進化結果不明（例如問號）</option>
                      <option value="unavailable">無法進化（沒有進化按鈕）</option>
                    </select>
                    <small>從招式頁判定；問號代表有進化按鈕，但無法確定結果。特殊造型等個體可能沒有進化按鈕。</small>
                  </label>
                  <label className="edit-field">
                    <span>極巨化狀態</span>
                    <select
                      value={maxStatus ?? ""}
                      onChange={(event) => setMaxStatus(
                        event.target.value === "" ? null :
                        event.target.value as "none" | "dynamax" | "gigantamax",
                      )}
                    >
                      <option value="">未能確認</option>
                      <option value="none">一般個體</option>
                      <option value="dynamax">極巨化</option>
                      <option value="gigantamax">超極巨化</option>
                    </select>
                    <small>依能力頁上的極巨化徽章判定；可在此人工修正。</small>
                  </label>
                  <details className="cost-edit">
                    <summary>
                      資源與畫面顯示成本
                      <ChevronDown size={14} />
                    </summary>
                    <div className="edit-fields">
                      {(
                        [
                          "candy",
                          "xlCandy",
                          "stardust",
                          "powerUpDust",
                          "powerUpCandy",
                          "evolutionCandy",
                          "secondMoveDust",
                          "secondMoveCandy",
                          "purificationDust",
                          "purificationCandy",
                        ] as (keyof Fields)[]
                      ).map(editor)}
                    </div>
                  </details>
                  <datalist id="move-options">
                    {catalog.moves.map((m) => (
                      <option key={m.id} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </datalist>
                </div>
              </div>
              <label className="verify-box">
                <input
                  type="checkbox"
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                />
                <span>
                  <strong>我已核對來源畫面與上述資料</strong>
                  <small>
                    未知欄位保持空白；缺少必要資料時仍會列為待確認。
                  </small>
                </span>
              </label>
            </>
          )}
          {section === "analysis" && (
            <div className="analysis-content">
              <div className={`decision-card ${a?.category || "review"}`}>
                <Status category={a?.category || "review"} />
                <h3>
                  {a?.category === "transfer"
                    ? "建議放生"
                    : a?.category === "invest"
                      ? "建議保留培養"
                      : a?.category === "collect"
                        ? "建議保留收藏"
                        : a?.category === "evolve"
                          ? "建議進化（進化型未登錄）"
                          : "資料不足，請先核對"}
                </h3>
                {a?.reasons.map((r, i) => (
                  <p key={i}>
                    <Check size={14} />
                    {localizeSpeciesName(localizeMoveText(r, moveNames))}
                  </p>
                ))}
              </div>
              {a?.actions.length ? (
                <section className="analysis-section">
                  <h3>
                    <ArrowUpRight size={17} />
                    培養步驟
                  </h3>
                  {a.actions.map((action, i) => (
                    <p className="action-item" key={i}>
                      <span>{i + 1}</span>
                      {localizeSpeciesName(localizeMoveText(action, moveNames))}
                    </p>
                  ))}
                </section>
              ) : null}
              {!!a?.leagues.length && (
                <section className="analysis-section">
                  <h3>
                    <Swords size={17} />
                    PvP 聯盟價值
                  </h3>
                  <p className="caption">
                    環境排名與個體 IV 排名分開比較；4,096 組合、等級上限 50。
                  </p>
                  {a.leagues.map((l) => (
                    <div
                      className={`league-card ${!l.eligible ? "ineligible" : ""}`}
                      key={`${l.speciesId}/${l.league}`}
                    >
                      <div>
                        <strong>{localizeSpeciesName(l.name, l.speciesId)}</strong>
                        <span className="subtle-tag">
                          {l.league === 1500
                            ? "超級聯盟"
                            : l.league === 2500
                              ? "高級聯盟"
                              : "大師聯盟"}
                        </span>
                      </div>
                      <div className="league-metrics">
                        <span>
                          環境排名
                          <strong>
                            {l.metaRank ? `#${l.metaRank}` : "未列入"}
                          </strong>
                        </span>
                        <span>
                          個體 IV
                          <strong>
                            #{l.ivRank}
                            <small> / 4096</small>
                          </strong>
                        </span>
                        <span>
                          目標等級<strong>{l.level}</strong>
                        </span>
                        <span>
                          目標 CP<strong>{l.cp}</strong>
                        </span>
                      </div>
                      <CostLine cost={l.cost} />
                      {!l.eligible && (
                        <p className="warning-text">
                          目前等級已超過此目標，或無法推算目前等級，不能直接用於此聯盟。
                        </p>
                      )}
                      {l.level > 40 && (
                        <p className="warning-text">
                          需要 XL 糖，列為長期目標。
                        </p>
                      )}
                      <p className="caption">
                        招式：
                        {l.moves
                          .map(
                            (m) =>
                              moveName(m, moveNames),
                          )
                          .join("／") || "資料不足"}
                        {l.elite.length
                          ? ` · 限定招式 ${l.elite.map((m) => moveName(m, moveNames)).join("、")}`
                          : ""}
                      </p>
                      <details>
                        <summary>最佳夥伴加成另列</summary>
                        <p className="caption">
                          同一個體目標等級再加一級後 CP {l.buddyCp}
                          ，可能超過聯盟上限，未納入 IV 排名。
                        </p>
                      </details>
                    </div>
                  ))}
                </section>
              )}
              {!!a?.raids.length && (
                <section className="analysis-section">
                  <h3>
                    <Swords size={17} />
                    團體戰培養比較
                  </h3>
                  <p className="caption">
                    固定防禦 150、中性傷害、同等級比較的簡化循環
                    DPS；不是指定頭目排名。
                  </p>
                  {a.raids
                    .sort((x, y) => x.rank - y.rank)
                    .map((r) => (
                      <div
                        className="raid-card"
                        key={`${r.speciesId}/${r.type}`}
                      >
                        <div>
                          <strong>{localizeSpeciesName(r.name, r.speciesId)}</strong>
                          <span className="subtle-tag">
                            {typeName(r.type)} · 物種 #{r.rank}
                          </span>
                        </div>
                        <p>
                          Lv.35 基準 DPS <b>{r.dps.toFixed(2)}</b> ·{" "}
                          {moveName(r.fast, moveNames)}{" "}
                          /{" "}
                          {moveName(r.charge, moveNames)}
                        </p>
                        {r.targets.map((t) => (
                          <div className="raid-target" key={t.level}>
                            <strong>
                              Lv.{t.level}
                              <small>
                                CP {t.cp} · DPS {t.dps.toFixed(2)}
                              </small>
                            </strong>
                            <CostLine cost={t.cost} />
                          </div>
                        ))}
                        {r.condition && (
                          <p className="warning-text">{r.condition}</p>
                        )}
                        {r.elite.length > 0 && (
                          <p className="warning-text">
                            包含限定招式：{r.elite.map((m) => moveName(m, moveNames)).join("、")}
                            ；請確認厲害招式學習器或活動條件。
                          </p>
                        )}
                      </div>
                    ))}
                </section>
              )}
              {a?.purification && (
                <section className="analysis-section">
                  <h3>
                    <Sparkles size={17} />
                    淨化比較
                  </h3>
                  <div className="purification-card">
                    <strong>淨化後 IV {a.purification.iv.join(" / ")}</strong>
                    <span>預估 CP {a.purification.cp ?? "待確認"}</span>
                    <p>{a.purification.verdict}</p>
                    <p className="caption">
                      畫面淨化成本：
                      {fields.purificationDust === null
                        ? "未知"
                        : number(fields.purificationDust)}{" "}
                      星塵／{fields.purificationCandy ?? "未知"} 糖果。
                    </p>
                  </div>
                </section>
              )}
              {a?.warnings.length ? (
                <div className="analysis-warnings">
                  <h3>
                    <Info size={16} />
                    計算限制與待補資訊
                  </h3>
                  <ul>
                    {a.warnings.map((w) => (
                      <li key={w}>{localizeSpeciesName(localizeMoveText(w, moveNames))}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="analysis-provenance">
                <Database size={14} />
                快照 {a?.snapshot || "尚無資料"} ·{" "}
                {a ? date(a.evaluatedAt) : "尚未評估"}
                <p>
                  比較範圍：已掃描且仍持有的寶可夢。
                  {a?.comparedWith.length
                    ? `與 ${a.comparedWith.length} 隻相關個體比較。`
                    : ""}
                </p>
              </div>
            </div>
          )}
          {section === "sources" && (
            <div className="sources-view">
              <p>點選截圖可回到「辨識核對」對照欄位。</p>
              <div className="source-grid">
                {p.sources.map((s, i) => (
                  <button
                    className={source === i ? "selected" : ""}
                    key={`${s.observationId}-${i}`}
                    onClick={() => {
                      setSource(i);
                      setSection("review");
                    }}
                  >
                    <img
                      src={`/api/frames/${s.frame}`}
                      alt={`${sourceName(s)} ${sourceTime(s)} 來源畫面`}
                      loading="lazy"
                    />
                    <strong>{sourceTime(s)}</strong>
                    <small>{sourceName(s)}</small>
                    <span>{s.fields.length} 個可見欄位</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="drawer-footer">
          <div>
            <button
              className={`button small ${p.locked ? "locked-button" : "secondary"}`}
              disabled={busy}
              onClick={() => void onSave({ locked: !p.locked })}
            >
              <LockKeyhole size={14} />
              {p.locked ? "已鎖定保留" : "鎖定保留"}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void onSave({ owned: !p.owned })}
            >
              {p.owned ? "標記已放生" : "恢復為持有"}
            </button>
          </div>
          {section === "review" ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void onSave({
                  fields: changes,
                  verified,
                  evolutionSilhouette,
                  maxStatus,
                  dismissCandidates: dismiss,
                })
              }
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Check size={15} />
              )}
              儲存並重新評估
            </button>
          ) : (
            <button
              className="button secondary"
              onClick={() => setSection("review")}
            >
              <ArrowLeft size={14} />
              回到核對
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
