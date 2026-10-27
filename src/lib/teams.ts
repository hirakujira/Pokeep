import type { LeagueResult, Pokemon, RaidResult } from "./types";
import { typeNames } from "./type-names";

export const pvpTeamSize = 3;
export const raidTeamSize = 6;

export type TeamMember<T> = { pokemon: Pokemon; slot: T };
export type PvpBenchMember = TeamMember<LeagueResult> & {
  /** Why a better-ranked member did not make the team. */
  blockedBy: "species" | "pokemon" | null;
};
export type PvpTeam = {
  league: number;
  starters: TeamMember<LeagueResult>[];
  bench: PvpBenchMember[];
};
export type RaidTeam = {
  type: string;
  starters: TeamMember<RaidResult>[];
  bench: TeamMember<RaidResult>[];
};

/**
 * A GO Battle League party holds three different species. Shadow and regional
 * forms are keyed by dex number, so they count as one species here.
 */
export function pvpTeams(
  records: Pokemon[],
  dexOf: (speciesId: string) => number | undefined,
): PvpTeam[] {
  return [1500, 2500, 10000].map((league) => {
    const members = records
      .flatMap((pokemon) =>
        (pokemon.analysis?.battleSlots.leagues ?? [])
          .filter((slot) => slot.league === league)
          .map((slot) => ({ pokemon, slot })),
      )
      .sort((a, b) =>
        (a.slot.metaRank ?? Infinity) - (b.slot.metaRank ?? Infinity) ||
        a.slot.ivRank - b.slot.ivRank,
      );
    const starters: TeamMember<LeagueResult>[] = [];
    const bench: PvpBenchMember[] = [];
    const species = new Set<number | string>();
    const pokemon = new Set<string>();
    for (const member of members) {
      const key = dexOf(member.slot.speciesId) ?? member.slot.speciesId;
      const blockedBy = species.has(key)
        ? "species"
        : pokemon.has(member.pokemon.id) ? "pokemon" : null;
      if (starters.length < pvpTeamSize && !blockedBy) {
        starters.push(member);
        species.add(key);
        pokemon.add(member.pokemon.id);
      } else bench.push({ ...member, blockedBy });
    }
    return { league, starters, bench };
  });
}

/** Raid parties take six Pokémon and may repeat a species. */
export function raidTeams(records: Pokemon[]): RaidTeam[] {
  const byType = new Map<string, TeamMember<RaidResult>[]>();
  for (const pokemon of records)
    for (const slot of pokemon.analysis?.battleSlots.raids ?? [])
      byType.set(slot.type, [...(byType.get(slot.type) ?? []), { pokemon, slot }]);
  const order = Object.keys(typeNames);
  return [...byType]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([type, members]) => {
      members.sort((a, b) =>
        b.slot.dps - a.slot.dps || a.pokemon.id.localeCompare(b.pokemon.id),
      );
      return {
        type,
        starters: members.slice(0, raidTeamSize),
        bench: members.slice(raidTeamSize),
      };
    });
}
