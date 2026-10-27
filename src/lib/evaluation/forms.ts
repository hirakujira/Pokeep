import { effective, type Fields, type Pokemon, type Snapshot, type Species } from "../types";
import { normalFormTexts } from "../species-names";

/**
 * The appearance form (Shellos's sea, Flabébé's flower colour…) the form text
 * names; scans and the drawer store either its label or its ID.
 */
export function visualForm(f: Fields, s: Species, snapshot: Snapshot) {
  if (s.form || !f.form) return null;
  const text = f.form.trim().toLowerCase();
  return snapshot.visualForms?.[s.dex]?.find((form) =>
    form.id === text || form.label.toLowerCase() === text) ?? null;
}
// A form-specific species ID already names its form; scanned labels for the
// same form vary ("攻擊形態", "(Attack)", "attack") and must not split groups.
export function collectionForm(f: Fields, s: Species, snapshot: Snapshot) {
  if (s.form) return s.form;
  const visual = visualForm(f, s, snapshot);
  if (visual) return visual.id;
  return !f.form || normalFormTexts.includes(f.form.trim().toLowerCase()) ? "normal" : f.form;
}
/** Whether a living Pokémon is the target in the given appearance form; an unknown form on either side counts as a match. */
export function holdsSameForm(living: Pokemon[], target: Species, form: string | null, snapshot: Snapshot) {
  return living.some((peer) => {
    const g = effective(peer);
    if (g.speciesId !== target.id) return false;
    const peerForm = visualForm(g, target, snapshot)?.id;
    return !form || !peerForm || peerForm === form;
  });
}
