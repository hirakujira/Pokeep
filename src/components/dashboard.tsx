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
  Clock3,
  Database,
  FileVideo2,
  Film,
  FolderHeart,
  HardDrive,
  Info,
  Layers3,
  Leaf,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Swords,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import {
  categoryLabels,
  defaultSettings,
  effective,
  fieldLabels,
  type Fields,
  type Job,
  type Pokemon,
  type Settings,
  type Cost,
} from "@/lib/types";

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
  jobs: Job[];
  settings: Settings;
  snapshot: SnapshotInfo | null;
  apiConfigured: boolean;
  model: string;
};
type Catalog = {
  species: { id: string; name: string; types: string[] }[];
  moves: { id: string; name: string }[];
};
type Tab = "import" | "results" | "collection" | "settings";
const empty: State = {
  pokemon: [],
  jobs: [],
  settings: defaultSettings,
  snapshot: null,
  apiConfigured: false,
  model: "gpt-4.1-mini",
};
const tabs = [
  { id: "import" as Tab, label: "匯入分析", icon: Video },
  { id: "results" as Tab, label: "清倉結果", icon: ClipboardCheck },
  { id: "collection" as Tab, label: "收藏庫", icon: FolderHeart },
  { id: "settings" as Tab, label: "設定", icon: Settings2 },
];
const typeNames: Record<string, string> = {
  normal: "一般",
  fire: "火",
  water: "水",
  electric: "電",
  grass: "草",
  ice: "冰",
  fighting: "格鬥",
  poison: "毒",
  ground: "地面",
  flying: "飛行",
  psychic: "超能力",
  bug: "蟲",
  rock: "岩石",
  ghost: "幽靈",
  dragon: "龍",
  dark: "惡",
  steel: "鋼",
  fairy: "妖精",
};
const icons = {
  transfer: Trash2,
  collect: FolderHeart,
  invest: Swords,
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
      <span className="brand-symbol">
        <i />
      </span>
      <span>
        pokékeep<span className="logo-dot">.</span>
      </span>
    </div>
  );
}

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("import"),
    [state, setState] = useState<State>(empty),
    [catalog, setCatalog] = useState<Catalog>({ species: [], moves: [] });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(""),
    [files, setFiles] = useState<File[]>([]),
    [drag, setDrag] = useState(false),
    [manual, setManual] = useState(false),
    [uploadProgress, setUploadProgress] = useState(0);
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("recent"),
    [selected, setSelected] = useState<string | null>(null),
    [showArchived, setShowArchived] = useState(false);
  const closeDrawer = useCallback(() => setSelected(null), []);
  const input = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null),
    uploadAbort = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await api<State>("state");
      setState(result);
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
  useEffect(() => {
    void refresh();
    void loadCatalog();
  }, [refresh, loadCatalog]);
  useEffect(() => {
    const timer = setInterval(
      () => void refresh(),
      state.jobs.some(
        (j) =>
          j.status === "processing" ||
          (j.status === "queued" && j.stage !== "等待上傳"),
      )
        ? 1500
        : 10000,
    );
    return () => clearInterval(timer);
  }, [state.jobs, refresh]);
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
  const navigate = (next: Tab) => {
    setTab(next);
    setQuery("");
    setFilter("all");
  };
  const acceptFiles = (incoming: File[]) => {
    const valid: File[] = [];
    for (const f of incoming) {
      if (!/\.(mp4|mov)$/i.test(f.name)) {
        setError(`${f.name}：僅支援 MP4／MOV`);
        continue;
      }
      if (f.size > 500 * 1024 * 1024) {
        setError(`${f.name}：不可超過 500 MB`);
        continue;
      }
      valid.push(f);
    }
    setFiles((current) => [...current, ...valid].slice(0, 20));
  };
  async function upload() {
    if (!files.length) return;
    const controller = new AbortController();
    uploadAbort.current = controller;
    let jobId: string | null = null;
    await act("upload", async () => {
      setUploadProgress(0);
      const job = await api<Job>("jobs", "POST", {
        name: `錄影分析 · ${new Date().toLocaleDateString("zh-TW")} · ${files.length} 段`,
      });
      jobId = job.id;
      for (let i = 0; i < files.length; i++) {
        const response = await fetch(
          `/api/jobs/${job.id}/files?name=${encodeURIComponent(files[i].name)}`,
          {
            method: "PUT",
            headers: {
              "x-pogo-local": "1",
              "Content-Type": "application/octet-stream",
            },
            body: files[i],
            signal: controller.signal,
          },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "影片上傳失敗");
        setUploadProgress(Math.round(((i + 1) / files.length) * 100));
      }
      await api(`jobs/${job.id}/start`, "POST", { manual });
      setFiles([]);
      notify(
        manual
          ? "已開始抽幀，完成後請核對個體資料"
          : "已開始分析，結果會自動更新",
      );
    });
    if (controller.signal.aborted && jobId)
      await api(`jobs/${jobId}/cancel`, "POST").catch(() => {});
    uploadAbort.current = null;
  }
  const living = state.pokemon.filter((p) => p.owned),
    counts = Object.fromEntries(
      Object.keys(categoryLabels).map((c) => [
        c,
        living.filter((p) => p.analysis?.category === c).length,
      ]),
    );
  const list = state.pokemon
    .filter(
      (p) =>
        (showArchived || p.owned) &&
        (filter === "all" || p.analysis?.category === filter) &&
        (query === "" ||
          `${effective(p).name || ""} ${effective(p).speciesId || ""} ${effective(p).cp || ""}`
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
  const chosen = selected ? state.pokemon.find((p) => p.id === selected) : null;
  const activeJob = state.jobs.find(
    (j) =>
      j.status === "processing" ||
      (j.status === "queued" && j.stage !== "等待上傳"),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="brand-caption">你的寶可夢整理工作台</div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="主要功能">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${tab === t.id ? "active" : ""}`}
              onClick={() => navigate(t.id)}
            >
              <t.icon size={19} />
              <span>{t.label}</span>
              {t.id === "results" && counts.review > 0 ? (
                <span className="nav-count">{counts.review}</span>
              ) : t.id === tab ? (
                <ChevronRight size={15} />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="note-icon">
            <Leaf size={19} />
          </div>
          <strong>留給下一場冒險</strong>
          <p>
            清掉重複，保留潛力。
            <br />
            每個建議，都能查看依據。
          </p>
          <span>RAIDS + GO BATTLE LEAGUE</span>
        </div>
        <div className="local-info">
          <span className="online-dot" />
          <div>
            <strong>本機私人工作區</strong>
            <small>收藏資料保存在這部電腦</small>
          </div>
          <LockKeyhole size={15} />
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>工作台</span>
            <ChevronRight size={13} />
            <strong>{tabs.find((t) => t.id === tab)?.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <span className="online-dot" />
              LOCAL ONLY
            </span>
            <span className="separator" />
            <button
              className="icon-button"
              title="重新整理"
              aria-label="重新整理"
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} />
            </button>
            <span className="user-avatar">H</span>
          </div>
        </header>
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
              <div className="eyebrow">
                {tab === "import"
                  ? "LESS CLUTTER. MORE POTENTIAL."
                  : tab === "results"
                    ? "MAKE ROOM FOR YOUR NEXT CATCH."
                    : tab === "collection"
                      ? "YOUR COLLECTION, IN PERSPECTIVE."
                      : "YOUR WORKSPACE. YOUR RULES."}
              </div>
              <h1>
                {tab === "import" ? (
                  <>
                    讓每一個倉庫格，
                    <br className="mobile-break" />
                    都留得值得<span className="title-dot">。</span>
                  </>
                ) : tab === "results" ? (
                  "把下一步，整理清楚。"
                ) : tab === "collection" ? (
                  "值得留下的，都在這裡。"
                ) : (
                  "依你的玩法，調整判斷。"
                )}
              </h1>
              <p>
                {tab === "import"
                  ? "匯入 Pokémon GO 螢幕錄影，一次看懂收藏、對戰與培養價值。"
                  : tab === "results"
                    ? "先核對，再決定。比較範圍為已匯入且仍持有的個體。"
                    : tab === "collection"
                      ? "跨影片保存個體，讓每一次清倉都有比較依據。"
                      : "設定資料來源、辨識服務與清倉偏好。"}
              </p>
            </div>
            {tab !== "import" && (
              <button
                className="button primary"
                onClick={() => navigate("import")}
              >
                <Plus size={16} />
                匯入錄影
              </button>
            )}
          </div>
          {tab !== "settings" && (
            <div className="stats-grid">
              {(
                Object.keys(categoryLabels) as (keyof typeof categoryLabels)[]
              ).map((category, index) => {
                const Icon = icons[category];
                return (
                  <button
                    key={category}
                    className={`stat-card ${category}`}
                    onClick={() => {
                      setTab("results");
                      setFilter(category);
                    }}
                  >
                    <div className="stat-top">
                      <span>{categoryLabels[category]}</span>
                      <Icon size={17} />
                    </div>
                    <div className="stat-number">
                      {loading ? (
                        <span className="skeleton-number" />
                      ) : (
                        String(counts[category] || 0).padStart(2, "0")
                      )}
                      <span>隻</span>
                    </div>
                    <div className="stat-caption">
                      {
                        [
                          "釋出空間，迎接下一隻",
                          "特殊收藏，各留代表",
                          "把資源花在潛力上",
                          "補齊資料，判斷更準確",
                        ][index]
                      }
                      <ArrowUpRight size={14} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {tab === "import" && (
            <>
              {!state.apiConfigured && (
                <div className="api-notice">
                  <div>
                    <span className="notice-dot" />
                    <strong>接上辨識服務，就能自動分析</strong>
                    <span>
                      尚未設定 OpenAI API key；也可以先抽幀，人工核對。
                    </span>
                  </div>
                  <button onClick={() => navigate("settings")}>
                    前往設定
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}
              <div className="import-grid">
                <section className="panel upload-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        <span className="step-square">01</span>匯入你的錄影
                      </h2>
                      <p>評價頁與招式頁可分段錄製，一起匯入。</p>
                    </div>
                    <span className="subtle-tag">MP4 / MOV</span>
                  </div>
                  <input
                    ref={input}
                    type="file"
                    multiple
                    accept=".mp4,.mov,video/mp4,video/quicktime"
                    className="visually-hidden"
                    onChange={(e) => {
                      acceptFiles(Array.from(e.target.files || []));
                      e.target.value = "";
                    }}
                  />
                  <div
                    className={`dropzone ${drag ? "dragging" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDrag(true);
                    }}
                    onDragLeave={() => setDrag(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDrag(false);
                      acceptFiles(Array.from(e.dataTransfer.files));
                    }}
                  >
                    <span className="upload-art">
                      <FileVideo2 size={35} strokeWidth={1.4} />
                      <span>
                        <Plus size={13} />
                      </span>
                    </span>
                    <h3>把錄影拖曳到這裡</h3>
                    <p>或從電腦選擇檔案，一次匯入多段影片</p>
                    <button
                      className="button white"
                      disabled={busy === "upload"}
                      onClick={() => input.current?.click()}
                    >
                      <Upload size={15} />
                      選擇錄影檔案
                    </button>
                    <div className="file-hint">
                      每段最多 500 MB · 最長 10 分鐘 · 每批最多 20 段
                    </div>
                  </div>
                  {files.length > 0 && (
                    <div className="file-list">
                      {files.map((f, i) => (
                        <div className="file-row" key={`${f.name}-${i}`}>
                          <FileVideo2 size={18} />
                          <div>
                            <strong>{f.name}</strong>
                            <small>
                              {(f.size / 1024 / 1024).toFixed(1)} MB
                            </small>
                          </div>
                          <button
                            className="icon-button"
                            aria-label={`移除 ${f.name}`}
                            disabled={busy === "upload"}
                            onClick={() =>
                              setFiles((items) =>
                                items.filter((_, j) => j !== i),
                              )
                            }
                          >
                            <X size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mode-row">
                    <label>
                      <input
                        type="radio"
                        checked={!manual}
                        onChange={() => setManual(false)}
                      />
                      AI 自動辨識
                    </label>
                    <label>
                      <input
                        type="radio"
                        checked={manual}
                        onChange={() => setManual(true)}
                      />
                      先抽幀，人工核對
                    </label>
                    <span>
                      <ShieldCheck size={14} />
                      只傳必要截圖
                    </span>
                  </div>
                  <div className="upload-bottom">
                    <span>
                      {busy === "upload"
                        ? `上傳中 ${uploadProgress}%`
                        : files.length
                          ? `已選擇 ${files.length} 段錄影`
                          : "錄影不會整段傳到雲端"}
                    </span>
                    {busy === "upload" ? (
                      <button
                        className="button secondary"
                        onClick={() => uploadAbort.current?.abort()}
                      >
                        <X size={15} />
                        取消上傳
                      </button>
                    ) : (
                      <button
                        className="button primary"
                        disabled={
                          !files.length ||
                          !!busy ||
                          (!manual && !state.apiConfigured)
                        }
                        onClick={() => void upload()}
                      >
                        {manual ? "開始抽幀核對" : "開始分析"}
                        <ArrowRight size={16} />
                      </button>
                    )}
                  </div>
                </section>
                <section className="panel recording-guide">
                  <div className="guide-label">
                    <Film size={16} />
                    一段好錄影，讓判斷更準確
                  </div>
                  <div
                    className="phone-illustration"
                    aria-label="評價頁錄影示意"
                  >
                    <div className="phone-notch" />
                    <div className="phone-cp">CP 1,482</div>
                    <div className="phone-arc" />
                    <div className="pokemon-placeholder">
                      <Layers3 size={42} strokeWidth={1} />
                    </div>
                    <div className="phone-sheet">
                      <span>寶可夢評價</span>
                      <div className="tiny-hp" />
                      <div className="iv-demo">
                        {[80, 100, 93].map((width, i) => (
                          <div key={i}>
                            <small>{["攻擊", "防禦", "HP"][i]}</small>
                            <span>
                              <i style={{ width: `${width}%` }} />
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <span className="phone-caption">評價頁示意</span>
                    <div className="guide-callout">
                      <CheckCircle2 size={14} />
                      保持 IV 評價條清楚
                    </div>
                  </div>
                  <ol className="guide-steps">
                    <li>
                      <span>1</span>
                      <div>
                        <strong>開啟隊長評價，逐隻切換</strong>
                        <p>每隻停留約 1～2 秒，等評價條穩定。</p>
                      </div>
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>另外錄下能力與招式</strong>
                        <p>滑動顯示招式與成本，可補齊培養建議。</p>
                      </div>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>一起匯入，核對後再清倉</strong>
                        <p>不需相同順序，不確定的配對會留給你確認。</p>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
              <section className="workflow-strip">
                <div>
                  <span className="workflow-icon">
                    <Upload size={20} />
                  </span>
                  <div>
                    <small>01 / IMPORT</small>
                    <strong>匯入螢幕錄影</strong>
                  </div>
                </div>
                <ChevronRight size={17} />
                <div>
                  <span className="workflow-icon">
                    <ScanSymbol />
                  </span>
                  <div>
                    <small>02 / REVIEW</small>
                    <strong>辨識、配對與核對</strong>
                  </div>
                </div>
                <ChevronRight size={17} />
                <div>
                  <span className="workflow-icon">
                    <Swords size={20} />
                  </span>
                  <div>
                    <small>03 / DECIDE</small>
                    <strong>看懂價值，再決定</strong>
                  </div>
                </div>
              </section>
              <div className="section-title">
                <h2>
                  最近的分析
                  <span>
                    {state.jobs.length
                      ? String(state.jobs.length).padStart(2, "0")
                      : ""}
                  </span>
                </h2>
                <button
                  className="text-button"
                  onClick={() => navigate("results")}
                >
                  查看清倉結果
                  <ArrowRight size={14} />
                </button>
              </div>
              <div className="panel jobs-panel">
                {state.jobs.length ? (
                  state.jobs.slice(0, 8).map((j) => (
                    <div className="job-row" key={j.id}>
                      <span className={`job-icon ${j.status}`}>
                        <FileVideo2 size={22} />
                      </span>
                      <div className="job-details">
                        <strong>{j.name}</strong>
                        <small>
                          {date(j.createdAt)} · {j.files.length} 段錄影 ·{" "}
                          {j.stage}
                        </small>
                        {j.status === "processing" && (
                          <div className="progress-track">
                            <i style={{ width: `${j.progress}%` }} />
                          </div>
                        )}
                        {j.error && <p className="job-error">{j.error}</p>}
                        <small>
                          {j.usage.requests > 0
                            ? `${number(j.usage.input)} 輸入 / ${number(j.usage.output)} 輸出 tokens · ${j.usage.cached} 次快取`
                            : ""}
                        </small>
                      </div>
                      <div className="job-actions">
                        {j.status === "processing" ? (
                          <>
                            <span className="processing">
                              <LoaderCircle size={13} className="spin" />
                              {j.progress}%
                            </span>
                            <button
                              className="icon-button"
                              title="取消"
                              onClick={() =>
                                void act("cancel", async () => {
                                  await api(`jobs/${j.id}/cancel`, "POST");
                                })
                              }
                            >
                              <X size={16} />
                            </button>
                          </>
                        ) : j.status === "failed" ||
                          j.status === "cancelled" ? (
                          <button
                            className="button small secondary"
                            disabled={!!busy}
                            onClick={() =>
                              void act("retry", async () => {
                                await api(`jobs/${j.id}/start`, "POST", {
                                  manual,
                                });
                              })
                            }
                          >
                            <RefreshCw size={13} />
                            重試
                          </button>
                        ) : j.stage === "等待上傳" ? (
                          <button
                            className="text-button"
                            onClick={() =>
                              void act("cancel", async () => {
                                await api(`jobs/${j.id}/cancel`, "POST");
                              })
                            }
                          >
                            移除未完成上傳
                          </button>
                        ) : (
                          <button
                            className="text-button"
                            onClick={() => navigate("results")}
                          >
                            核對結果
                            <ChevronRight size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-jobs">
                    <span>
                      <Clock3 size={22} />
                    </span>
                    <div>
                      <strong>你的第一份分析，從一段錄影開始</strong>
                      <p>分析紀錄與核對進度會保存在這裡。</p>
                    </div>
                    <span className="empty-label">READY WHEN YOU ARE</span>
                  </div>
                )}
              </div>
            </>
          )}
          {(tab === "results" || tab === "collection") && (
            <>
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
                          ? "全部個體"
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
                        notify("已依目前收藏庫重新評估");
                      })
                    }
                  >
                    <RefreshCw size={14} />
                    重新評估
                  </button>
                </div>
                <div className="search-toolbar">
                  <label className="search-box">
                    <Search size={16} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="搜尋名稱、物種 ID 或 CP"
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
                      <option value="recent">最近匯入</option>
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
                {list.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>寶可夢</th>
                          <th>CP / IV</th>
                          <th>建議分類</th>
                          <th>判斷依據</th>
                          <th>核對狀態</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((p) => {
                          const f = effective(p);
                          return (
                            <tr
                              key={p.id}
                              onClick={() => setSelected(p.id)}
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") setSelected(p.id);
                              }}
                            >
                              <td>
                                <div className="pokemon-cell">
                                  <div className="pokemon-token">
                                    {p.locked ? (
                                      <LockKeyhole size={20} />
                                    ) : f.shadow ? (
                                      <span>◈</span>
                                    ) : (
                                      <Layers3 size={23} />
                                    )}
                                  </div>
                                  <div>
                                    <strong>
                                      {f.name ||
                                        catalog.species.find(
                                          (s) => s.id === f.speciesId,
                                        )?.name ||
                                        "待辨識個體"}
                                      {f.shiny && <Sparkles size={12} />}
                                    </strong>
                                    <small>
                                      {f.speciesId || "尚未指定物種"}
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
                              </td>
                              <td className="reason-cell">
                                {p.analysis?.reasons[0] || "等待分析"}
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
                        ? "沒有符合條件的個體"
                        : "收藏的全貌，從這裡開始"}
                    </h3>
                    <p>
                      {state.pokemon.length
                        ? "試著切換分類或搜尋條件。"
                        : "匯入錄影後，在這裡查看每一隻的去留與培養建議。"}
                    </p>
                    <button
                      className="button primary"
                      onClick={() => navigate("import")}
                    >
                      <Plus size={15} />
                      匯入第一段錄影
                    </button>
                  </div>
                )}
                <div className="table-footer">
                  <span>共 {list.length} 隻 · 僅比較本機已匯入收藏</span>
                  <span>
                    <Info size={13} />
                    資料不足的個體維持待確認
                  </span>
                </div>
              </div>
              {activeJob && (
                <div className="alert">
                  <LoaderCircle size={16} className="spin" />
                  <span>正在分析：{activeJob.stage}，完成後將自動更新。</span>
                </div>
              )}
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
              <Leaf size={13} />
              留下潛力，讓冒險繼續。
            </span>
            <span>
              {state.snapshot
                ? `遊戲資料 ${state.snapshot.sourceDate.split(" ")[0]} · ${number(state.snapshot.count)} 種物種／形態`
                : "尚未載入遊戲資料"}
              <span className="footer-dot">·</span>Pokékeep v0.1
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
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
              notify("個體已更新，已重新評估收藏庫");
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
function ScanSymbol() {
  return (
    <span className="scan-symbol">
      <i />
      <i />
      <i />
    </span>
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
  useEffect(
    () => setPreferences(state.settings),
    [
      state.settings.raidSlots,
      state.settings.metaCutoff,
      state.settings.ivCutoff,
      state.settings.rareRepresentatives,
    ],
  );
  return (
    <div className="settings-grid">
      <section className="panel settings-card">
        <div className="settings-icon">
          <Sparkles size={21} />
        </div>
        <h2>畫面辨識服務</h2>
        <p>OpenAI API key 僅由本機後端讀取，不儲存在瀏覽器。</p>
        <div
          className={`connection-state ${state.apiConfigured ? "connected" : ""}`}
        >
          <span className="online-dot" />
          {state.apiConfigured ? "API key 已設定" : "尚未設定 API key"}
          <small>{state.model}</small>
        </div>
        <ol className="setup-list">
          <li>
            在專案根目錄建立 <code>.env.local</code>
          </li>
          <li>填入自己的 key 與模型名稱：</li>
        </ol>
        <pre>OPENAI_API_KEY=你的_API_key{"\n"}OPENAI_MODEL=gpt-4.1-mini</pre>
        <p className="caption">
          儲存後重新啟動 <code>npm run dev</code>。呼叫 API
          會依實際用量計費；未設定時可先使用人工核對模式。
        </p>
        <a
          className="text-link"
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noreferrer"
        >
          管理 OpenAI API keys
          <ArrowUpRight size={14} />
        </a>
      </section>
      <section className="panel settings-card">
        <div className="settings-icon">
          <Database size={21} />
        </div>
        <h2>遊戲資料快照</h2>
        <p>更新後重新評估現有收藏；更新失敗會保留舊版本。</p>
        {state.snapshot ? (
          <div className="snapshot-details">
            <div>
              <span>資料日期（PvPoke）</span>
              <strong>{state.snapshot.sourceDate}</strong>
            </div>
            <div>
              <span>本機更新時間</span>
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
        <div className="settings-icon">
          <SlidersHorizontal size={21} />
        </div>
        <h2>清倉與培養偏好</h2>
        <p>積極清倉，各留收藏代表；優先培養立即有用的個體。</p>
        <div className="preference-fields">
          {(
            [
              { key: "raidSlots", label: "每種攻擊屬性保留隊伍名額", max: 6 },
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
        <div className="settings-icon">
          <HardDrive size={21} />
        </div>
        <h2>你的收藏，存在本機</h2>
        <p>
          備份包含個體、人工修正、資料快照與來源截圖；不包含原始影片或 API key。
        </p>
        <div className="storage-summary">
          <strong>
            {state.pokemon.length}
            <span>個體紀錄</span>
          </strong>
          <strong>
            {state.jobs.length}
            <span>分析工作</span>
          </strong>
        </div>
        <div className="button-row">
          <a className="button secondary" href="/api/export">
            <ArrowDownToLine size={15} />
            JSON 完整備份
          </a>
          <a className="button secondary" href="/api/export?format=csv">
            <ArrowDownToLine size={15} />
            CSV 清單
          </a>
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
        <button
          className="text-button restore-button"
          disabled={!!busy}
          onClick={() => backupInput.current?.click()}
        >
          <Upload size={14} />
          匯入 JSON 備份
        </button>
        <div className="privacy-note">
          <ShieldCheck size={17} />
          <span>
            本機服務僅開放 127.0.0.1。匯入備份時，既有個體與人工修正不會被覆蓋。
          </span>
        </div>
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
    [source, setSource] = useState(0),
    [verified, setVerified] = useState(p.verified),
    [dismiss, setDismiss] = useState(false),
    [proofError, setProofError] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null),
    panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setFields(effective(p));
    setVerified(p.verified);
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
    activeSource = p.sources[Math.min(source, p.sources.length - 1)];
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
    return (
      <label className="edit-field" key={key}>
        <span>
          {fieldLabels[key]}
          {Object.hasOwn(p.overrides, key) && <small>已修正</small>}
        </span>
        {key === "speciesId" ? (
          <select
            value={fields.speciesId || ""}
            onChange={(e) => {
              const s = catalog.species.find((s) => s.id === e.target.value);
              setFields((f) => ({
                ...f,
                speciesId: e.target.value || null,
                ...(s
                  ? {
                      shadow: s.id.endsWith("_shadow"),
                      name: f.name || s.name.split(" ")[0],
                    }
                  : {}),
              }));
              setVerified(false);
            }}
          >
            <option value="">選擇物種／形態</option>
            {catalog.species.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.id}
              </option>
            ))}
          </select>
        ) : bool ? (
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
              value={String(fields[key] ?? "")}
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
            <span className="eyebrow">POKÉMON DETAIL</span>
            <h2 id="drawer-title">
              {fields.name || "待辨識個體"}
              <Status category={a?.category || "review"} />
            </h2>
            <p>
              {fields.speciesId || "請選擇正確物種"} · {p.sources.length}{" "}
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
                      alt={`${activeSource.video} ${activeSource.time} 秒來源截圖`}
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
                      <strong>{activeSource.time.toFixed(2)} 秒</strong>
                      <small>{activeSource.video}</small>
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
                      <option key={m.id} value={m.id}>
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
              <div className="decision-card">
                <Status category={a?.category || "review"} />
                <h3>
                  {a?.category === "transfer"
                    ? "這一隻，可以釋出空間。"
                    : a?.category === "invest"
                      ? "這一隻，值得留下培養。"
                      : a?.category === "collect"
                        ? "留下這位收藏代表。"
                        : "先補齊資訊，再下結論。"}
                </h3>
                {a?.reasons.map((r, i) => (
                  <p key={i}>
                    <Check size={14} />
                    {r}
                  </p>
                ))}
              </div>
              {a?.actions.length ? (
                <section className="analysis-section">
                  <h3>
                    <ArrowUpRight size={17} />
                    下一步培養路線
                  </h3>
                  {a.actions.map((action, i) => (
                    <p className="action-item" key={i}>
                      <span>{i + 1}</span>
                      {action}
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
                        <strong>{l.name}</strong>
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
                              catalog.moves.find((x) => x.id === m)?.name || m,
                          )
                          .join("／") || "資料不足"}
                        {l.elite.length
                          ? ` · 限定招式 ${l.elite.join("、")}`
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
                          <strong>{r.name}</strong>
                          <span className="subtle-tag">
                            {typeNames[r.type] || r.type} · 物種 #{r.rank}
                          </span>
                        </div>
                        <p>
                          Lv.35 基準 DPS <b>{r.dps.toFixed(2)}</b> ·{" "}
                          {catalog.moves.find((x) => x.id === r.fast)?.name ||
                            r.fast}{" "}
                          /{" "}
                          {catalog.moves.find((x) => x.id === r.charge)?.name ||
                            r.charge}
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
                            包含限定招式：{r.elite.join("、")}
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
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="analysis-provenance">
                <Database size={14} />
                快照 {a?.snapshot || "尚無資料"} ·{" "}
                {a ? date(a.evaluatedAt) : "尚未評估"}
                <p>
                  比較範圍：本機已匯入且仍持有的個體。
                  {a?.comparedWith.length
                    ? `與 ${a.comparedWith.length} 隻相關個體比較。`
                    : ""}
                </p>
              </div>
            </div>
          )}
          {section === "sources" && (
            <div className="sources-view">
              <p>點選畫面，再回「辨識核對」可對照欄位。時間為原影片時間點。</p>
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
                      alt={`${s.time} 秒來源畫面`}
                      loading="lazy"
                    />
                    <strong>{s.time.toFixed(2)} 秒</strong>
                    <small>{s.video}</small>
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
