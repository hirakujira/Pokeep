import { useId, useState } from "react";
import { ChevronDown, UsersRound } from "lucide-react";
import { effective, type LeagueResult, type Pokemon, type RaidResult } from "@/lib/types";
import { localizeSpeciesName } from "@/lib/species-names";
import { typeName } from "@/lib/type-names";
import {
  pvpTeams,
  pvpTeamSize,
  raidTeams,
  raidTeamSize,
  type PvpBenchMember,
  type TeamMember,
} from "@/lib/teams";
import type { Catalog } from "./types";
import { PokemonSprite, useSavedOpen } from "./ui";

type Select = (id: string) => void;
type Slot = LeagueResult | RaidResult;

const leagueNames: Record<number, string> = {
  1500: "超級聯盟",
  2500: "高級聯盟",
  10000: "大師聯盟",
};
const blockedNotes = {
  species: "同物種已在隊伍",
  pokemon: "這隻已以其他進化型入隊",
};

function Member<T extends Slot>({
  member: { pokemon, slot },
  metric,
  note,
  onSelect,
}: {
  member: TeamMember<T>;
  metric: string;
  note?: string | null;
  onSelect: Select;
}) {
  const f = effective(pokemon);
  return (
    <li>
      <button type="button" className="team-member" onClick={() => onSelect(pokemon.id)}>
        <PokemonSprite pokemon={pokemon} />
        <span className="team-member-name">
          <strong>{localizeSpeciesName(slot.name, slot.speciesId)}</strong>
          <small>
            {f.speciesId !== slot.speciesId ? "需進化 · " : ""}
            CP {f.cp ?? "?"} · IV {f.ivAtk ?? "?"}/{f.ivDef ?? "?"}/{f.ivSta ?? "?"}
          </small>
        </span>
        <span className="team-metric">
          {metric}
          {note && <small>{note}</small>}
        </span>
      </button>
    </li>
  );
}

function TeamCard<T extends Slot, B extends TeamMember<T>>({
  title,
  size,
  starters,
  bench,
  benchLabel,
  metric,
  note,
  onSelect,
}: {
  title: string;
  size: number;
  starters: TeamMember<T>[];
  bench: B[];
  benchLabel: string;
  metric: (slot: T) => string;
  note?: (member: B) => string | null;
  onSelect: Select;
}) {
  return (
    <div className="team-card">
      <div className="team-card-head">
        <strong>{title}</strong>
        <span className="subtle-tag">{`${starters.length} / ${size}`}</span>
      </div>
      {starters.length ? (
        <ol className="team-members">
          {starters.map((m) => (
            <Member
              key={`${m.pokemon.id}/${m.slot.speciesId}`}
              member={m}
              metric={metric(m.slot)}
              onSelect={onSelect}
            />
          ))}
        </ol>
      ) : (
        <p className="caption">沒有入選的寶可夢</p>
      )}
      {bench.length > 0 && (
        <details className="team-bench">
          <summary>{`${benchLabel} ${bench.length} 隻`}</summary>
          <ol className="team-members">
            {bench.map((m) => (
              <Member
                key={`${m.pokemon.id}/${m.slot.speciesId}`}
                member={m}
                metric={metric(m.slot)}
                note={note?.(m)}
                onSelect={onSelect}
              />
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

export function TeamsPanel({
  records,
  catalog,
  onSelect,
}: {
  records: Pokemon[];
  catalog: Catalog;
  onSelect: Select;
}) {
  const [open, toggle] = useSavedOpen("pokeep-teams-open");
  const [tab, setTab] = useState<"pvp" | "raid">("pvp");
  const baseId = useId();
  const active = records.filter(
    (p) => p.owned && p.analysis && p.analysis.category !== "review",
  );
  const dex = new Map(catalog.species.map((s) => [s.id, s.dex]));
  const pvp = pvpTeams(active, (id) => dex.get(id));
  const raid = raidTeams(active);
  const tabs = [
    { id: "pvp", label: "PvP 對戰聯盟", count: pvp.filter((t) => t.starters.length).length },
    { id: "raid", label: "團體戰", count: raid.length },
  ] as const;
  return (
    <section className="panel tm-panel">
      <button type="button" className="tm-toggle" aria-expanded={open} onClick={toggle}>
        <UsersRound size={20} />
        <span className="tm-toggle-title">
          <strong>隊伍組合</strong>
          <small>
            {open
              ? "依入選類型分組，只整理已入選名額的個體，不改變保留或放生建議。點選寶可夢可開啟詳情。"
              : `PvP ${tabs[0].count} 個聯盟 · 團體戰 ${tabs[1].count} 種屬性`}
          </small>
        </span>
        <span className="tm-toggle-hint">{open ? "收起" : "展開"}</span>
        <ChevronDown size={18} />
      </button>
      {open && (
        <>
          <div className="filter-tabs tm-tabs" role="tablist" aria-label="隊伍類型">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${baseId}-${t.id}-tab`}
                aria-controls={`${baseId}-${t.id}`}
                aria-selected={tab === t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                <span>{t.count}</span>
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${baseId}-pvp`}
            aria-labelledby={`${baseId}-pvp-tab`}
            hidden={tab !== "pvp"}
          >
            <p className="caption team-caption">
              每隊 3 隻，同物種不能同隊（暗影與地區形態也算同一物種）。依 PvPoke
              環境排名取前 3 個不同物種，其餘列為候補。
            </p>
            <div className="team-grid">
              {pvp.map((team) => (
                <TeamCard<LeagueResult, PvpBenchMember>
                  key={team.league}
                  title={leagueNames[team.league]}
                  size={pvpTeamSize}
                  starters={team.starters}
                  bench={team.bench}
                  benchLabel="候補"
                  metric={(l) => `環境 #${l.metaRank} · IV #${l.ivRank}`}
                  note={(m) => (m.blockedBy ? blockedNotes[m.blockedBy] : null)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
          <div
            role="tabpanel"
            id={`${baseId}-raid`}
            aria-labelledby={`${baseId}-raid-tab`}
            hidden={tab !== "raid"}
          >
            <p className="caption team-caption">
              每隊 6 隻，可帶同物種多隻，但同一時間只能有一隻超級進化。依 Lv.35 DPS
              排序，前 6 隻為主力，其餘名額列為二軍。
            </p>
            {raid.length ? (
              <div className="team-grid">
                {raid.map((team) => (
                  <TeamCard<RaidResult, TeamMember<RaidResult>>
                    key={team.type}
                    title={`${typeName(team.type)}屬性`}
                    size={raidTeamSize}
                    starters={team.starters}
                    bench={team.bench}
                    benchLabel="二軍"
                    metric={(r) => `DPS ${r.dps.toFixed(2)}`}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ) : (
              <p className="caption team-caption">目前沒有入選團體戰的寶可夢。</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
