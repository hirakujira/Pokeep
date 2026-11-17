import OpenAI from "openai";
import { z } from "zod";
import { leagueNames } from "./evaluation/move-training";
import { moveName } from "./move-names";
import { openAiClient } from "./openai-config";
import { getRuntimeConfig } from "./runtime-config";
import { getSnapshot, listPokemon } from "./store";
import { typeName } from "./type-names";
import { categoryLabels, effective, type Pokemon, type Snapshot } from "./types";

export const askInput = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4000),
  })).min(1).max(20),
});

/** One line per owned Pokémon with the fields and evaluation an answer needs. */
export function collectionContext(records: Pokemon[], snapshot: Snapshot | null) {
  const owned = records.filter((p) => p.owned);
  const lines = owned.map((p) => {
    const f = effective(p), a = p.analysis;
    const flags = [f.shiny && "色違", f.shadow && "暗影", f.purified && "淨化", f.favorite && "最愛", f.costume, p.locked && "鎖定"]
      .filter(Boolean).join("/");
    const pvp = (a?.leagues ?? []).filter((l) => l.eligible && l.metaRank !== null).map((l) =>
      `${l.name} ${leagueNames[l.league] ?? l.league} 環境#${l.metaRank} IV#${l.ivRank}`).join("; ");
    const raid = (a?.raids ?? []).map((r) => `${r.name} ${typeName(r.type)}#${r.rank}`).join("; ");
    return [
      p.id,
      `${f.name ?? "?"}(${f.speciesId ?? "?"}${f.form ? ` ${f.form}` : ""})`,
      `CP${f.cp ?? "?"}`,
      `IV ${f.ivAtk ?? "?"}/${f.ivDef ?? "?"}/${f.ivSta ?? "?"}`,
      [f.fastMove, f.chargeMove, f.chargeMove2].flatMap((m) => m ? [moveName(m, snapshot?.moveNames)] : []).join(",") || "-",
      flags || "-",
      a ? categoryLabels[a.category] : "未評估",
      a?.reasons.join("；") || "-",
      pvp || "-",
      raid || "-",
    ].join(" | ");
  });
  return [
    `持有 ${owned.length} 隻。欄位：id | 名稱(物種) | CP | IV 攻/防/HP | 招式 | 標記 | 分類 | 分類理由 | PvP（可達物種 聯盟 環境排名 IV 排名） | 團體戰（可達物種 屬性排名）`,
    ...lines,
  ].join("\n");
}

export async function askAi(input: unknown) {
  const { messages } = askInput.parse(input);
  const client = openAiClient({ maxRetries: 1, timeout: 120000 });
  const response = await client.responses.create({
    model: getRuntimeConfig().model,
    store: false,
    instructions:
      "你是 Pokémon GO 收藏顧問。只根據下列資料庫紀錄回答使用者，用繁體中文，提到個體時附上名稱、CP 與 IV。" +
      "資料沒有的資訊要直說不知道，不要編造。\n\n" +
      // shortcut: sends the whole owned collection on every question; switch to tool-based lookup if boxes reach many thousands.
      collectionContext(listPokemon(), getSnapshot()),
    input: messages,
  }).catch((error) => {
    if (error instanceof OpenAI.APIError)
      throw new Error(`AI 服務回應錯誤（HTTP ${error.status ?? "連線失敗"}）：${error.message}`);
    throw error;
  });
  return response.output_text;
}
