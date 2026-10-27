import { localizeForm, normalFormTexts } from "@/lib/species-names";
import type { VisualForm } from "@/lib/types";
import type { Catalog } from "./types";

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

function catalogFormLabel(s: Catalog["species"][number]) {
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

export function speciesWithShadow(id: string, shadow: boolean | null, ids: Set<string>) {
  if (shadow === null) return id;
  const base = id.replace(/_shadow$/, "");
  return shadow && ids.has(`${base}_shadow`) ? `${base}_shadow` : base;
}
