import { useId, useState, type ReactNode } from "react";
import { ChevronDown, Disc3 } from "lucide-react";
import {
  effective,
  moveTrainingTmLabels,
  type MoveTrainingAdvice,
  type MoveTrainingStep,
  type MoveTrainingTm,
  type Pokemon,
} from "@/lib/types";
import { moveName } from "@/lib/move-names";
import { localizeSpeciesName } from "@/lib/species-names";
import { PokemonSprite, useSavedOpen } from "./ui";

type MoveNames = Record<string, string>;
type Entry = { pokemon: Pokemon; advice: MoveTrainingAdvice; step: MoveTrainingStep };
type Select = (id: string) => void;

const tmOrder: MoveTrainingTm[] = ["fast", "charged", "eliteFast", "eliteCharged"];
const visibleRows = 5;
const columns = 5;
const shortLabels: Record<MoveTrainingTm, string> = {
  fast: "一般",
  charged: "特殊",
  eliteFast: "厲害一般",
  eliteCharged: "厲害特殊",
};
const isElite = (tm: MoveTrainingTm) => tm === "eliteFast" || tm === "eliteCharged";

function oddsLabel(step: MoveTrainingStep) {
  if (isElite(step.tm)) return "直接指定";
  return step.odds === 1 ? "必定抽中" : `1/${step.odds}`;
}
const oddsSentence = (step: MoveTrainingStep) =>
  isElite(step.tm) || step.odds === 1 ? oddsLabel(step) : `成功率 ${oddsLabel(step)}`;
function moveChange(step: MoveTrainingStep, moveNames: MoveNames) {
  const to = moveName(step.to, moveNames);
  return step.from ? `${moveName(step.from, moveNames)} → ${to}` : `第二特殊招式 → ${to}`;
}
function dpsLabel(dps: MoveTrainingAdvice["dps"]) {
  if (!dps) return null;
  const gain = Math.round(((dps.best - dps.current) / dps.current) * 100);
  return `${dps.current.toFixed(2)} → ${dps.best.toFixed(2)}（${gain >= 0 ? "+" : ""}${gain}%）`;
}
// Each ordinary TM roll hits the target with probability 1/odds, so odds is
// also the expected number of TMs spent; both orders rank value per TM.
const expectedGain = ({ advice, step }: Entry) =>
  advice.dps
    ? (advice.dps.best - advice.dps.current) / advice.dps.current / step.odds
    : null;
function raidOrder(a: Entry, b: Entry) {
  const x = expectedGain(a), y = expectedGain(b);
  return Number(a.step.blocked) - Number(b.step.blocked) ||
    (x === null || y === null ? Number(x === null) - Number(y === null) : y - x) ||
    a.advice.rank - b.advice.rank;
}
function pvpOrder(a: Entry, b: Entry) {
  return Number(a.step.blocked) - Number(b.step.blocked) ||
    a.advice.rank * a.step.odds - b.advice.rank * b.step.odds ||
    a.advice.rank - b.advice.rank;
}

function TmRow({
  entry: { pokemon, advice, step },
  moveNames,
  onSelect,
}: {
  entry: Entry;
  moveNames: MoveNames;
  onSelect: Select;
}) {
  const f = effective(pokemon);
  return (
    <tr
      tabIndex={0}
      onClick={() => onSelect(pokemon.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect(pokemon.id);
      }}
    >
      <td>
        <div className="pokemon-cell">
          <PokemonSprite pokemon={pokemon} />
          <div>
            <strong>
              <span className="pokemon-display-name">
                {localizeSpeciesName(advice.name, advice.speciesId)}
              </span>
            </strong>
            <small>
              CP {f.cp ?? "?"} · IV {f.ivAtk ?? "?"}/{f.ivDef ?? "?"}/{f.ivSta ?? "?"}
            </small>
          </div>
        </div>
      </td>
      <td className="tm-move">
        {moveChange(step, moveNames)}
        {step.note && <small className={step.blocked ? "blocked" : ""}>{step.note}</small>}
      </td>
      <td>{advice.label}</td>
      <td>
        <span className={`tm-odds ${isElite(step.tm) || step.odds === 1 ? "sure" : ""}`}>
          {oddsLabel(step)}
        </span>
      </td>
      <td className="tm-dps">{dpsLabel(advice.dps) ?? "—"}</td>
    </tr>
  );
}

function TmGroup({
  title,
  entries,
  moveNames,
  onSelect,
}: {
  title: string;
  entries: Entry[];
  moveNames: MoveNames;
  onSelect: Select;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? entries : entries.slice(0, visibleRows);
  return (
    <tbody>
      <tr className="tm-static tm-group-row">
        <th colSpan={columns} scope="rowgroup">
          {title}
          <span>{entries.length} 項</span>
        </th>
      </tr>
      {rows.map((entry, i) => (
        <TmRow
          key={`${entry.pokemon.id}/${entry.advice.label}/${i}`}
          entry={entry}
          moveNames={moveNames}
          onSelect={onSelect}
        />
      ))}
      {!entries.length && (
        <tr className="tm-static">
          <td colSpan={columns} className="tm-none">沒有需要的對象</td>
        </tr>
      )}
      {entries.length > visibleRows && (
        <tr className="tm-static tm-more">
          <td colSpan={columns}>
            <button type="button" onClick={() => setShowAll(!showAll)}>
              {showAll ? "只顯示前 5 項" : `再顯示 ${entries.length - visibleRows} 項`}
            </button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

function TmTable({ children }: { children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table className="tm-table">
        <thead>
          <tr>
            <th>寶可夢</th>
            <th>換招</th>
            <th>用途</th>
            <th>成功率</th>
            <th>Lv.35 DPS 變化</th>
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

function TmTabPanel({
  tm,
  entries,
  moveNames,
  onSelect,
  id,
  tabId,
  hidden,
}: {
  tm: MoveTrainingTm;
  entries: Entry[];
  moveNames: MoveNames;
  onSelect: Select;
  id: string;
  tabId: string;
  hidden: boolean;
}) {
  const own = entries.filter((e) => e.step.tm === tm);
  const raid = own.filter((e) => e.advice.purpose === "raid").sort(raidOrder);
  const pvp = own.filter((e) => e.advice.purpose === "pvp").sort(pvpOrder);
  const elite = isElite(tm);
  const fallback = elite && !own.length
    ? entries
        .filter((e) =>
          e.step.tm === (tm === "eliteFast" ? "fast" : "charged") &&
          !e.step.blocked && e.step.odds >= 3,
        )
        .sort((a, b) => b.step.odds - a.step.odds || a.advice.rank - b.advice.rank)
        .slice(0, 3)
    : [];
  return (
    <div role="tabpanel" id={id} aria-labelledby={tabId} hidden={hidden}>
      {own.length ? (
        <TmTable>
          <TmGroup title="團體戰" entries={raid} moveNames={moveNames} onSelect={onSelect} />
          <TmGroup title="PvP" entries={pvp} moveNames={moveNames} onSelect={onSelect} />
        </TmTable>
      ) : (
        <>
          <p className="caption tm-empty">
            {elite
              ? "目前沒有需要限定招式的對象。厲害學習器較稀有，可以先留著。"
              : "目前沒有需要這種學習器的對象。"}
          </p>
          {fallback.length > 0 && (
            <TmTable>
              <TmGroup
                title="想用的話，可直接指定這些一般學習器成功率低的招式"
                entries={fallback}
                moveNames={moveNames}
                onSelect={onSelect}
              />
            </TmTable>
          )}
        </>
      )}
    </div>
  );
}

export function MoveTrainingPanel({
  records,
  moveNames,
  onSelect,
}: {
  records: Pokemon[];
  moveNames: MoveNames;
  onSelect: Select;
}) {
  const [open, toggle] = useSavedOpen("pokeep-move-training-open");
  const [tab, setTab] = useState<MoveTrainingTm>("fast");
  const baseId = useId();
  const active = records.filter(
    (p) => p.owned && p.analysis && p.analysis.category !== "review",
  );
  const advised = active.flatMap((pokemon) =>
    pokemon.analysis!.moveTraining.map((advice) => ({ pokemon, advice })),
  );
  const entries = advised
    .filter(({ advice }) => advice.status === "train")
    .flatMap(({ pokemon, advice }) =>
      advice.steps.map((step) => ({ pokemon, advice, step })),
    );
  const evolveFirst = new Set(
    advised
      .filter(({ advice }) => advice.status === "evolveFirst")
      .map(({ pokemon }) => pokemon.id),
  ).size;
  const counts = Object.fromEntries(
    tmOrder.map((tm) => [tm, entries.filter((e) => e.step.tm === tm).length]),
  ) as Record<MoveTrainingTm, number>;
  const summary = tmOrder.map((tm) => `${shortLabels[tm]} ${counts[tm]} 項`).join(" · ");
  return (
    <section className="panel tm-panel">
      <button
        type="button"
        className="tm-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <Disc3 size={20} />
        <span className="tm-toggle-title">
          <strong>招式學習器建議</strong>
          <small>
            {open
              ? "只列入選團體戰或 PvP 名額、目前招式和建議不同的個體。點選列可開啟詳情。"
              : summary}
          </small>
        </span>
        <span className="tm-toggle-hint">{open ? "收起" : "展開"}</span>
        <ChevronDown size={18} />
      </button>
      {open && (
        <>
          <div className="filter-tabs tm-tabs" role="tablist" aria-label="學習器種類">
            {tmOrder.map((tm) => (
              <button
                key={tm}
                type="button"
                role="tab"
                id={`${baseId}-${tm}-tab`}
                aria-controls={`${baseId}-${tm}`}
                aria-selected={tab === tm}
                className={tab === tm ? "active" : ""}
                onClick={() => setTab(tm)}
              >
                {moveTrainingTmLabels[tm]}
                <span>{counts[tm]}</span>
              </button>
            ))}
          </div>
          {tmOrder.map((tm) => (
            <TmTabPanel
              key={tm}
              tm={tm}
              entries={entries}
              moveNames={moveNames}
              onSelect={onSelect}
              id={`${baseId}-${tm}`}
              tabId={`${baseId}-${tm}-tab`}
              hidden={tab !== tm}
            />
          ))}
          <p className="caption tm-footnote">
            團體戰依「DPS 提升幅度 ÷ 平均需要幾顆學習器」排序，越大越前面；PvP 依「PvPoke 環境排名 × 平均需要幾顆學習器」排序，越小越前面。一般學習器隨機抽招，成功率依目前招式池估算；社群日與活動限定招式仍須在遊戲核對。
            {evolveFirst
              ? `另有 ${evolveFirst} 隻的培養目標是進化型；進化會重新抽招式，先進化再決定學習器。`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}

export function MoveTrainingSection({
  advice,
  moveNames,
}: {
  advice: MoveTrainingAdvice[];
  moveNames: MoveNames;
}) {
  return (
    <section className="analysis-section">
      <h3>
        <Disc3 size={17} />
        招式學習器
      </h3>
      <p className="caption">一般學習器隨機抽招；厲害學習器可直接指定，包含限定招式。</p>
      {advice.map((a, i) => {
        const name = localizeSpeciesName(a.name, a.speciesId);
        const dps = dpsLabel(a.dps);
        return (
          <div className="tm-advice" key={`${a.purpose}/${a.label}/${i}`}>
            <div>
              <strong>{name}</strong>
              <span className="subtle-tag">{a.label}</span>
            </div>
            {a.status === "ready" && <p>目前招式已符合建議，不需要學習器。</p>}
            {a.status === "incomplete" && (
              <p>招式資料未完整，補齊後才能判斷要用哪種學習器。</p>
            )}
            {a.status === "evolveFirst" && (
              <p>{`培養目標是進化後的 ${name}；進化會重新抽招式，先進化再決定要不要用學習器。`}</p>
            )}
            {a.steps.map((step, j) => (
              <p className="tm-step" key={j}>
                <span className={`tm-badge ${step.tm}`}>{moveTrainingTmLabels[step.tm]}</span>
                {`${moveChange(step, moveNames)} · ${oddsSentence(step)}`}
                {step.note && <em className={step.blocked ? "blocked" : ""}>{step.note}</em>}
              </p>
            ))}
            {dps && <p className="caption">{`Lv.35 DPS ${dps}`}</p>}
          </div>
        );
      })}
    </section>
  );
}
