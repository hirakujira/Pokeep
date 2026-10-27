"use client";
import { useCallback, useRef, useState } from "react";
import { CheckCircle2, CircleHelp, RefreshCw, Smartphone, X } from "lucide-react";
import { categoryLabels } from "@/lib/types";
import { tabs } from "./constants";
import { number } from "./format";
import { IphoneView } from "./iphone-view";
import { MoveTrainingPanel } from "./move-training";
import { PokemonDrawer } from "./pokemon-drawer";
import { pokemonActions } from "./pokemon-actions";
import { ResultsPanel } from "./results-panel";
import { SettingsView } from "./settings-view";
import { Sidebar } from "./sidebar";
import { StatsGrid } from "./stats-grid";
import { TeamsPanel } from "./teams";
import {
  BatchProgressPanel,
  PausedBatchesPanel,
  TransferToast,
  transferProgress,
} from "./transfer-batch";
import type { Tab } from "./types";
import { useActions } from "./use-actions";
import { useDashboardData } from "./use-dashboard-data";
import { useScanActions } from "./use-scan-actions";
import { useToast } from "./use-toast";
import { useTransferActions } from "./use-transfer-actions";
import { useTransferSearchExclusions } from "./use-transfer-search-exclusions";

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("iphone"),
    [error, setError] = useState("");
  const { searchExclusions, toggleSearchExclusion } = useTransferSearchExclusions(setError);
  const { state, catalog, loading, phoneState, refresh, loadCatalog, refreshPhone } =
    useDashboardData(setError);
  const { toast, notify } = useToast();
  const { busy, act, phoneAct } = useActions(refresh, refreshPhone, setError);
  const scanActions = useScanActions(phoneAct, notify);
  const transferActions = useTransferActions(phoneAct, notify, searchExclusions);
  const { reevaluate, savePokemon, mergePokemon } = pokemonActions(act, notify);
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("recent"),
    [selected, setSelected] = useState<string | null>(null),
    [checkedTransfers, setCheckedTransfers] = useState<string[]>([]),
    [showArchived, setShowArchived] = useState(false);
  const closeDrawer = useCallback(() => setSelected(null), []);
  const backupInput = useRef<HTMLInputElement>(null);
  const navigate = (next: Tab) => {
    setTab(next);
    setQuery("");
    setFilter("all");
  };
  const living = state.pokemon.filter((p) => p.owned),
    counts = Object.fromEntries(
      Object.keys(categoryLabels).map((c) => [
        c,
        living.filter((p) => p.analysis?.category === c).length,
      ]),
    );
  const moveNames = Object.fromEntries(catalog.moves.map((move) => [move.id, move.name]));
  const chosen = selected ? state.pokemon.find((p) => p.id === selected) : null;
  const batch = phoneState?.batch;
  const progress = batch ? transferProgress(batch, state.pokemon) : null;
  const showBatchToast = Boolean(
    tab === "results" && batch && transferActions.dismissedBatchId !== batch.id &&
    (["approved", "running"].includes(batch.status) ||
      transferActions.trackedBatchId === batch.id ||
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
      <Sidebar
        tab={tab}
        reviewCount={counts.review}
        phoneStatus={phoneStatus}
        apiConfigured={state.apiConfigured}
        onNavigate={navigate}
      />
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
            <StatsGrid
              living={living}
              counts={counts}
              loading={loading}
              filter={filter}
              onFilter={setFilter}
            />
          )}
          {tab === "iphone" && (
            <IphoneView
              phoneState={phoneState}
              phoneStatus={phoneStatus}
              apiConfigured={state.apiConfigured}
              busy={busy}
              actions={scanActions}
            />
          )}
          {tab === "results" && (
            <>
              {batch && progress && (
                <BatchProgressPanel
                  batch={batch}
                  progress={progress}
                  records={state.pokemon}
                  busy={busy}
                  onSelect={setSelected}
                  actions={transferActions}
                />
              )}
              {phoneState?.resumableBatches?.some((row) => row.id !== batch?.id) && (
                <PausedBatchesPanel
                  batches={phoneState.resumableBatches}
                  batch={batch}
                  busy={busy}
                  actions={transferActions}
                />
              )}
              {filter === "invest" && (
                <TeamsPanel records={living} catalog={catalog} onSelect={setSelected} />
              )}
              {filter === "invest" && (
                <MoveTrainingPanel
                  records={living}
                  moveNames={moveNames}
                  onSelect={setSelected}
                />
              )}
              <ResultsPanel
                records={state.pokemon}
                catalog={catalog}
                living={living}
                counts={counts}
                query={query}
                onQuery={setQuery}
                filter={filter}
                onFilter={setFilter}
                sort={sort}
                onSort={setSort}
                showArchived={showArchived}
                onShowArchived={setShowArchived}
                checkedTransfers={checkedTransfers}
                setCheckedTransfers={setCheckedTransfers}
                searchExclusions={searchExclusions}
                onToggleSearchExclusion={toggleSearchExclusion}
                batch={batch}
                busy={busy}
                onSelect={setSelected}
                onNavigate={navigate}
                onReevaluate={reevaluate}
                onStartTransfers={transferActions.startSelectedTransfers}
              />
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
      {showBatchToast && batch && progress && (
        <TransferToast
          batch={batch}
          progress={progress}
          busy={busy}
          actions={transferActions}
        />
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
          onSave={(data, announce) => savePokemon(chosen.id, data, announce)}
          onMerge={(source) => mergePokemon(chosen.id, source)}
          busy={!!busy}
        />
      )}
    </div>
  );
}
