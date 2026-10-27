import type { Pokemon } from "@/lib/types";
import { api } from "./api";
import type { Notify, RunAction } from "./types";

export function pokemonActions(act: RunAction, notify: Notify) {
  const reevaluate = () => {
    void act("evaluate", async () => {
      await api("reevaluate", "POST");
      notify("已重新計算建議");
    });
  };
  const savePokemon = async (
    id: string,
    data: unknown,
    announce = true,
  ): Promise<Pokemon | null> => {
    let updated: Pokemon | null = null;
    await act("save", async () => {
      updated = await api<Pokemon>(`pokemon/${id}`, "PATCH", data);
    });
    if (updated && announce) notify("已儲存並重新評估");
    return updated;
  };
  const mergePokemon = async (target: string, source: string) => {
    await act("merge", async () => {
      await api("merge", "POST", { target, source });
      notify("已合併，請重新核對欄位");
    });
  };
  return { reevaluate, savePokemon, mergePokemon };
}
