import { CheckCircle2, ChevronRight, CircleHelp, Sparkles, Star } from "lucide-react";
import { effective, type Pokemon } from "@/lib/types";
import { localizeMoveText } from "@/lib/move-names";
import { localizeSpeciesName } from "@/lib/species-names";
import { displayPokemonName, evolutionCandySummary, speciesLabel } from "./format";
import type { Catalog } from "./types";
import { PokemonSprite, Status } from "./ui";

export function PokemonRow({
  pokemon: p,
  catalog,
  moveNames,
  pokemonById,
  retainedEvolutionBySpecies,
  retainedMaxBySpecies,
  checked,
  onToggle,
  onSelect,
}: {
  pokemon: Pokemon;
  catalog: Catalog;
  moveNames: Record<string, string>;
  pokemonById: Map<string, Pokemon>;
  retainedEvolutionBySpecies: Map<string, Pokemon>;
  retainedMaxBySpecies: Map<string, Pokemon>;
  checked: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const f = effective(p);
  const name = displayPokemonName(
    f.name || catalog.species.find((s) => s.id === f.speciesId)?.name || "待辨識個體",
    f.costume,
    f.speciesId,
  );
  const candySummary = p.analysis?.category === "evolve"
    ? evolutionCandySummary(p.analysis.evolutionCandy)
    : null;
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
      onClick={() => onSelect(p.id)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect(p.id);
      }}
    >
      <td className="transfer-check-cell">
        {p.owned && p.analysis?.category === "transfer" && (
          <input
            type="checkbox"
            aria-label={`勾選 ${name} CP ${f.cp ?? "未知"}`}
            checked={checked}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={() => onToggle(p.id)}
          />
        )}
      </td>
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
        {candySummary && (
          <span className={`candy-readiness ${candySummary.tone}`}>
            {candySummary.label}
          </span>
        )}
        {retainedEvolution && (
          <button
            className="retained-evolution-link"
            title="查看已保留的可進化個體"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(retainedEvolution.id);
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
              onSelect(retainedMax.id);
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
}
