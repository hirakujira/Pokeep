import { localizeForm, normalFormTexts } from "@/lib/species-names";
import type { Fields, Gender, VisualForm } from "@/lib/types";
import type { Catalog } from "./types";

type CatalogSpecies = Catalog["species"][number];

export type FormOption = {
  key: string;
  label: string;
  /** Non-shadow species ID to store; null leaves the species to be confirmed. */
  speciesId: string | null;
  /** Text to store in Fields.form; catalog forms are named by the species ID instead. */
  form: string | null;
  /** Species IDs (catalog forms) or lower-case form texts (appearance forms) this option stands for. */
  matches: string[];
};
export type DexEntry = { dex: number; name: string; options: FormOption[] };

export const unknownForm = "待確認";
export const keptFormKey = "?raw";
const normalForm = "一般";
// The plain ID predates the plumage IDs, so it does not say which plumage it is.
const unknownFormBases = new Set(["squawkabilly"]);
const normalTexts = new Set(normalFormTexts);

function catalogFormLabel(s: CatalogSpecies) {
  if (unknownFormBases.has(s.id)) return unknownForm;
  if (!s.form) return normalForm;
  if (!s.form.startsWith("(")) return s.form;
  return [...s.form.matchAll(/\(([^()]+)\)/g)]
    .map(([, form]) => localizeForm(form, s.id) ?? form)
    .join("・");
}

/** One entry per dex: shadow IDs fold into the shadow field, forms into the form list. */
export function dexEntries(
  species: Catalog["species"],
  visualForms: Record<string, VisualForm[]> = {},
): DexEntry[] {
  const byDex = new Map<number, Catalog["species"]>();
  for (const s of species)
    if (!s.id.endsWith("_shadow")) byDex.set(s.dex, [...(byDex.get(s.dex) ?? []), s]);
  return [...byDex].sort(([a], [b]) => a - b).map(([dex, variants]) => {
    const catalog: FormOption[] = [];
    for (const s of variants) {
      const label = catalogFormLabel(s);
      const same = catalog.find((option) => option.label === label);
      // Alias IDs such as nidoran_m name the same form as an existing ID.
      if (same) same.matches.push(s.id);
      else catalog.push({ key: s.id, label, speciesId: s.id, form: null, matches: [s.id] });
    }
    const name = (variants.find((s) => !s.form) ?? variants[0]).name.replace(/\s*[（(].*$/, "");
    return { dex, name, options: formOptions(catalog, visualForms[dex] ?? []) };
  });
}

function formOptions(catalog: FormOption[], visual: VisualForm[]): FormOption[] {
  const only = catalog[0];
  if (catalog.length === 1 && visual.length)
    return [
      { ...only, key: "", label: unknownForm, matches: [] },
      ...visual.map((form) => ({
        key: form.id,
        label: form.label,
        speciesId: only.speciesId,
        form: form.label,
        matches: form.id === "normal" ? [...normalTexts] : [form.id, form.label.toLowerCase()],
      })),
    ];
  // A lone catalog form (Meloetta's Aria) is still this Pokémon's only form.
  if (catalog.length === 1)
    return [{ ...only, label: normalForm, matches: [...only.matches, only.label.toLowerCase()] }];
  if (catalog.some((option) => option.label === normalForm || option.label === unknownForm))
    return catalog;
  return [{ key: "", label: unknownForm, speciesId: null, form: null, matches: [] }, ...catalog];
}
/**
 * The option the saved fields stand for. Form text that names no option is
 * kept as its own choice, so it stays visible and can be replaced.
 */
export function formChoice(entry: DexEntry, speciesId: string | null, form: string | null) {
  const id = speciesId?.replace(/_shadow$/, "");
  const text = form?.trim().toLowerCase() || null;
  const visual = entry.options.some((option) => option.form !== null);
  const selected = visual
    ? entry.options.find((option) => option.form !== null && text !== null && option.matches.includes(text)) ??
      entry.options[0]
    : (id && entry.options.find((option) => option.matches.includes(id))) ||
      entry.options.find((option) => option.label === normalForm) ||
      entry.options[0];
  const catalogForms = !visual && entry.options.length > 1;
  const raw = form && text && !catalogForms && selected.form === null &&
    !normalTexts.has(text) && !selected.matches.includes(text) ? form : null;
  if (!raw) return { options: entry.options, selected };
  const kept = { ...selected, key: keptFormKey, label: `${selected.label}（原始辨識「${raw}」）`, form: raw };
  return { options: [kept, ...entry.options], selected: kept };
}

export function speciesWithShadow(id: string, shadow: boolean | null, ids: { has(id: string): boolean }) {
  if (shadow === null) return id;
  const base = id.replace(/_shadow$/, "");
  return shadow && ids.has(`${base}_shadow`) ? `${base}_shadow` : base;
}

export const allGenders: Gender[] = ["male", "female", "genderless"];

/**
 * The choices a select offers when the species limits its values. A single
 * allowed value is fixed; a stored value the species does not allow stays
 * listed so the conflict can be seen and fixed.
 */
export function restrictedChoice<T>(all: T[], allowed: T[] | undefined, current: T | null) {
  const values = allowed ?? all;
  if (values.length === 1 && (current === null || current === values[0]))
    return { options: values as (T | null)[], value: values[0] as T | null, fixed: true };
  const conflict = current !== null && !values.includes(current) ? [current] : [];
  return { options: [null, ...values, ...conflict], value: current, fixed: false };
}

export type ShadowState = "none" | "shadow" | "purified";
export const shadowStates: ShadowState[] = ["none", "shadow", "purified"];

/** The shadow and purified fields as one state; null while it is not confirmed. */
export function shadowState(f: Pick<Fields, "shadow" | "purified">): ShadowState | null {
  if (f.shadow === true) return "shadow";
  if (f.purified === true) return "purified";
  return f.shadow === false && f.purified === false ? "none" : null;
}

export function shadowFields(state: ShadowState | null): Pick<Fields, "shadow" | "purified"> {
  if (state === null) return { shadow: null, purified: null };
  return { shadow: state === "shadow", purified: state === "purified" };
}

/** Gender and shadow states the species allows; undefined while the species is unknown. */
export function speciesLimits(speciesId: string | null, species: Map<string, CatalogSpecies>) {
  const s = speciesId ? species.get(speciesId) : undefined;
  if (!s) return { gender: undefined, shadow: undefined };
  const hasShadow = species.has(`${s.id.replace(/_shadow$/, "")}_shadow`);
  return { gender: s.genders, shadow: hasShadow ? shadowStates : ["none" as const] };
}

/** Fields with the values the species fixes filled in, so saving stores what the drawer shows. */
export function withFixedValues(f: Fields, species: Map<string, CatalogSpecies>): Fields {
  const limits = speciesLimits(f.speciesId, species);
  const state = restrictedChoice(shadowStates, limits.shadow, shadowState(f)).value;
  return {
    ...f,
    gender: restrictedChoice(allGenders, limits.gender, f.gender).value,
    // An unconfirmed state keeps what was stored, e.g. shadow: false with purified unknown.
    ...(state === null ? {} : shadowFields(state)),
  };
}

export type MaxStatus = "none" | "dynamax" | "gigantamax";
export const maxStatuses: MaxStatus[] = ["none", "dynamax", "gigantamax"];

/** Max states the species allows; undefined while the species or its Max data is unknown. */
export function maxLimits(speciesId: string | null, species: Map<string, CatalogSpecies>) {
  const forms = speciesId ? species.get(speciesId)?.maxForms : undefined;
  return forms && (["none", ...forms] as MaxStatus[]);
}

/** True when no evolve button can show: no evolution, Mega Evolution or Primal Reversion. */
export function lacksEvolutionButton(speciesId: string | null, species: Map<string, CatalogSpecies>) {
  const s = speciesId ? species.get(speciesId) : undefined;
  return s?.evolves === false && !s.mega;
}

/**
 * Why this Pokémon cannot have the cost, shown in place of the value; null
 * when it can. A stored value stays editable so a misread can be cleared.
 */
export function unavailableCost(key: keyof Fields, f: Fields, species: Map<string, CatalogSpecies>) {
  if (f[key] !== null) return null;
  if (key === "evolutionCandy")
    return f.speciesId && species.get(f.speciesId)?.evolves === false ? "無法進化" : null;
  if (key !== "purificationDust" && key !== "purificationCandy") return null;
  const state = shadowState(f),
    allowed = speciesLimits(f.speciesId, species).shadow;
  if (state === "purified") return "已經淨化";
  if (allowed && !allowed.includes("shadow")) return "沒有暗影形態";
  return state === "none" ? "不是暗影寶可夢" : null;
}
