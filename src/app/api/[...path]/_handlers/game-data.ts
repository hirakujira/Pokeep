import { getSnapshot } from "@/lib/store";
import { reevaluate } from "@/lib/evaluate";
import { publicSnapshot, updateGameData } from "@/lib/game-data";
import { moveName } from "@/lib/move-names";
import { json } from "./http";

export function speciesCatalog() {
  const snapshot = getSnapshot();
  return json({
    species: Object.values(snapshot?.species || {}).map((s) => ({
      id: s.id,
      dex: s.dex,
      name: s.name,
      types: s.types,
      form: s.form,
      genders: s.genders,
      evolves: s.evolutions.length > 0,
    })),
    visualForms: snapshot?.visualForms ?? {},
    moves: Object.values(snapshot?.moves || {}).map((m) => ({
      id: m.id,
      name: moveName(m.id, snapshot?.moveNames),
    })),
  });
}
export async function refreshGameData() {
  const snapshot = await updateGameData();
  reevaluate();
  return json(publicSnapshot(snapshot));
}
