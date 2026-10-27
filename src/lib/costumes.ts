import { effective, type Pokemon, type Snapshot } from "./types";
import { localizeSpeciesName } from "./species-names";

export type CostumeNames = { names: string[]; aliases: Map<string, string> };

export const costumeSpeciesKey = (speciesId: string) => speciesId.replace(/_shadow$/, "");
const textKey = (text: string) => text.replace(/\s+/g, "");

/**
 * Costume names the collection already uses, per species. Names a person
 * corrected or verified come first; each corrected reading becomes an alias
 * of the name it was corrected to.
 */
export function knownCostumes(records: Pokemon[]): Map<string, CostumeNames> {
  const scores = new Map<string, Map<string, number>>(),
    aliases = new Map<string, Map<string, string>>();
  for (const p of records) {
    const f = effective(p);
    if (!f.speciesId || !f.costume) continue;
    const key = costumeSpeciesKey(f.speciesId),
      corrected = Object.hasOwn(p.overrides, "costume"),
      names = scores.get(key) ?? new Map<string, number>();
    names.set(f.costume, (names.get(f.costume) ?? 0) +
      (corrected ? 100 : p.verification === "human" ? 10 : 1));
    scores.set(key, names);
    if (corrected && p.fields.costume && p.fields.costume !== f.costume)
      aliases.set(key, (aliases.get(key) ?? new Map<string, string>())
        .set(textKey(p.fields.costume), f.costume));
  }
  return new Map([...scores].map(([key, names]) => {
    const replaced = aliases.get(key) ?? new Map<string, string>();
    return [key, {
      names: [...names]
        .filter(([name]) => !replaced.has(textKey(name)))
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .map(([name]) => name),
      aliases: replaced,
    }];
  }));
}

/** The known name a reading stands for; an unknown reading stays as it is. */
export function canonicalCostume(known: CostumeNames | undefined, costume: string | null) {
  if (!costume || !known) return costume;
  const text = textKey(costume);
  return known.aliases.get(text) ?? known.names.find((name) => textKey(name) === text) ?? costume;
}

/** One line per species: its display name and the costume names to reuse. */
export function costumeVocabulary(known: Map<string, CostumeNames>, snapshot: Snapshot | null) {
  return [...known].flatMap(([id, { names }]) => {
    const s = snapshot?.species[id];
    return s && names.length ? [`${localizeSpeciesName(s.name, id)}：${names.join("、")}`] : [];
  }).sort();
}
