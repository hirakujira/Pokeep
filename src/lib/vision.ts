import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDir, get, put } from "./store";
import { fieldsSchema, emptyFields, type Fields, type Snapshot } from "./types";
import { resolveSpecies } from "./game-data";

const schema = z.object({
  kind: z.enum(["appraisal", "details", "transition", "other"]),
  fields: fieldsSchema,
  issues: z.array(z.string().max(200)),
  clear: z.boolean(),
});
export type VisionResult = z.infer<typeof schema>;
const promptVersion = "pogo-iphone-zh-v3";
const instructions = `你是繁體中文 Pokémon GO 螢幕錄影資料擷取器，只讀畫面，不給培養建議。畫面是裁切掉狀態列及地點的 iPhone 截圖。輸出 schema 全部欄位，未看見或不確定一律 null，不得猜測。
name 使用原始畫面名稱。speciesId 若確定則使用 PvPoke 英文 ID（例如 grimer_alolan_shadow）；不確定 null。form 使用 normal / alolan / galarian / hisuian / paldean 或明確英文形態，不要把性別當形態。注意阿羅拉臭泥是毒/惡，普通臭泥是毒。名稱可能是暱稱，不等於物種。
ivAtk/ivDef/ivSta 只能讀隊長評價三條刻度（0到15），沒有評價條不能從星數、CP 或物種推測。hp 是最大 HP（例如 30/72 讀72）。shadow/purified/shiny/favorite 必須見到可辨識的圖示或特徵，否則 null；若完整外觀清楚足以排除某特徵可 false。costume 沒有服裝時 null；不要將地方形態當成服裝。
fastMove/chargeMove/chargeMove2 保留畫面中文招式，未顯示 null。糖果、XL、星塵只讀數字。powerUpDust/Candy 是強化按鈕旁單次成本，evolutionCandy 是進化按鈕成本，secondMoveDust/Candy 是新攻擊招式成本。強化確認視窗中的新 CP 不得當目前 CP，視窗遮擋則 issues 說明並標 transition。不要將招式威力、捕獲日期、星數或身高體重的 XL 標記混入數字欄位。height 公尺 weight 公斤。
不得輸出地點、捕獲日期、玩家姓名或其他個資。快速滑動、混合兩隻、按鈕視窗或模糊時 clear=false 並寫 issues，仍盡可能讀可見欄位，不能虛構。`;
export async function recognize(
  frame: string,
  snapshot: Snapshot | null,
  signal: AbortSignal,
  onUsage: (usage: { input: number; output: number; cached: boolean }) => void,
): Promise<VisionResult> {
  const image = await fs.readFile(path.join(dataDir, "frames", frame)),
    model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const hash = createHash("sha256")
    .update(promptVersion)
    .update(model)
    .update(snapshot?.version || "none")
    .update(image)
    .digest("hex");
  const cached = get<VisionResult>("vision_cache", hash);
  if (cached) {
    onUsage({ input: 0, output: 0, cached: true });
    return cached;
  }
  if (!process.env.OPENAI_API_KEY)
    throw new Error(
      "尚未設定 OPENAI_API_KEY。請在 .env.local 設定後重啟，或先使用人工核對模式。",
    );
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: 90000,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await client.responses.parse(
        {
          model,
          store: false,
          input: [
            { role: "system", content: instructions },
            {
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:image/jpeg;base64,${image.toString("base64")}`,
                  detail: "high",
                },
              ],
            },
          ],
          text: { format: zodTextFormat(schema, "pokemon_observation") },
        },
        { signal },
      );
      onUsage({
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
        cached: false,
      });
      const parsed = response.output_parsed;
      if (!parsed)
        throw new Error("模型未回傳可解析的辨識資料，請重試或人工核對");
      const result = schema.parse(parsed);
      if (snapshot) {
        const s = resolveSpecies(
          snapshot,
          result.fields.name,
          result.fields.form,
          result.fields.shadow,
          result.fields.speciesId,
        );
        if (s) result.fields.speciesId = s.id;
        else result.issues.push("物種／形態無法唯一對應，請選擇正確物種");
        for (const key of ["fastMove", "chargeMove", "chargeMove2"] as const) {
          const value = result.fields[key];
          if (!value) continue;
          const matches = Object.values(snapshot.moves).filter(
            (m) => m.name === value || m.id === value,
          );
          if (matches.length === 1) result.fields[key] = matches[0].id;
        }
      }
      put("vision_cache", hash, result);
      return result;
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : null;
      if (attempt === 2 || (status !== 429 && (!status || status < 500))) {
        if (status === 401 || status === 403)
          throw new Error(
            "OpenAI API key 驗證失敗或沒有模型權限，請檢查本機設定。",
          );
        if (status === 429)
          throw new Error(
            "OpenAI 用量或速率限制；已自動重試，請稍後重試並檢查 API 額度。",
          );
        if (status && status >= 500)
          throw new Error(
            "OpenAI 服務暫時無法使用；已保留畫面與完成的辨識，請稍後重試。",
          );
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 1000 * 2 ** attempt);
        function abort() {
          clearTimeout(timer);
          reject(new Error("分析已取消"));
        }
        function done() {
          signal.removeEventListener("abort", abort);
          resolve();
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
  throw new Error("辨識失敗");
}
export function reconcileIV(
  fields: Fields,
  measured: number[] | null,
): { fields: Fields; issues: string[] } {
  const result = { ...fields },
    issues: string[] = [];
  if (measured)
    for (const [i, key] of (["ivAtk", "ivDef", "ivSta"] as const).entries()) {
      if (result[key] !== null && result[key] !== measured[i])
        issues.push(
          `${key}：AI ${result[key]} 與評價條量測 ${measured[i]} 不一致`,
        );
      // A measurement alone is a proposal for human review, never a verified observation.
      if (result[key] === null) result[key] = measured[i];
    }
  return { fields: result, issues };
}
export function manualObservation(measured: number[] | null): VisionResult {
  return {
    kind: measured ? "appraisal" : "details",
    fields: {
      ...emptyFields(),
      ...(measured
        ? { ivAtk: measured[0], ivDef: measured[1], ivSta: measured[2] }
        : {}),
    },
    issues: ["人工核對模式：請依來源畫面填寫欄位，尚未呼叫 AI"],
    clear: false,
  };
}
