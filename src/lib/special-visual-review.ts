import { createHash } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { openAiBaseURL, openAiClient } from "./openai-config";
import { getRuntimeConfig } from "./runtime-config";
import { upperAppearanceImage } from "./shiny-review";
import { get, put } from "./store";
import type { Fields, Snapshot } from "./types";

const promptVersion = "special-visual-two-frame-v3";
const state = z.enum(["normal", "shadow", "purified", "uncertain"]);
const resultSchema = z.object({
  top: state,
  appraisal: state,
  topClear: z.boolean(),
  appraisalClear: z.boolean(),
  reason: z.string().max(400),
});
type Judgment = z.infer<typeof resultSchema>;

export function specialVisualConsensus(judgment: Judgment) {
  return judgment.topClear && judgment.appraisalClear &&
    judgment.top === judgment.appraisal && judgment.top !== "uncertain"
    ? judgment.top
    : "uncertain" as const;
}

/** A normal-looking still does not prove a Pokémon was never purified. */
export function applySpecialVisualVerdict(
  fields: Fields,
  verdict: "normal" | "shadow" | "purified" | "uncertain",
  snapshot: Snapshot | null,
) {
  if (fields.shadow !== null || fields.purified !== null || fields.costume !== null) return;
  if (verdict === "normal") {
    // Two clear ordinary appearances can exclude the persistent shadow aura,
    // but they cannot prove the Pokémon was never purified.
    fields.shadow = false;
  } else if (verdict === "purified") {
    fields.shadow = false;
    fields.purified = true;
  } else if (verdict === "shadow" && fields.speciesId && snapshot) {
    const shadowId = `${fields.speciesId.replace(/_shadow$/, "")}_shadow`;
    if (snapshot.species[shadowId]) {
      fields.shadow = true;
      fields.purified = false;
      fields.speciesId = shadowId;
    }
  }
}

export async function reviewSpecialVisual(
  topFile: string,
  appraisalFile: string,
  signal: AbortSignal,
  onUsage: (usage: { input: number; output: number; cached: boolean }) => void,
) {
  const [top, appraisal] = await Promise.all([
    upperAppearanceImage(topFile),
    upperAppearanceImage(appraisalFile),
  ]);
  if (!top || !appraisal) return null;
  const model = getRuntimeConfig().model;
  const hash = createHash("sha256")
    .update(promptVersion)
    .update(openAiBaseURL() || "https://api.openai.com/v1")
    .update(model)
    .update(top)
    .update(appraisal)
    .digest("hex");
  let judgment = get<Judgment>("vision_cache", hash);
  if (judgment) onUsage({ input: 0, output: 0, cached: true });
  else {
    const client = openAiClient({ maxRetries: 0, timeout: 90000 });
    const instruction = `你只判斷同一隻 Pokémon GO 寶可夢的暗影、淨化或一般外觀。第一張是能力頁，第二張是隊長評價頁；兩張來自不同時刻。請分別判斷兩張，不要用物種名稱、招式、CP、最愛星、天氣背景或評價師衣服推測。暗影需看見緊貼寶可夢的紫色煙霧／火焰等明確效果；淨化需看見緊貼本體的白色淨化光環或標記。服裝、氣球、繩索、背包、翅膀與它們的藍白色部件不是淨化效果；無法區分時判 uncertain。隊長評價頁常有大片黃色、白色圓形背景光斑；它們與寶可夢輪廓分離時不是淨化效果，也不妨礙判 normal。若寶可夢本體及緊貼本體的效果區清楚可見、沒有兩類特殊效果，可以判 normal。只有本體或緊貼本體的效果區被遮住、切掉、模糊，或光圈確實包住本體而無法分辨時，才判 uncertain 並設 clear=false。右側淺色遮罩是刻意遮住日期，不是特殊效果。只用畫面證據，不推測未顯示內容，不輸出日期或玩家資訊。`;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await client.responses.parse(
          {
            model,
            store: false,
            input: [
              { role: "system", content: instruction },
              {
                role: "user",
                content: [top, appraisal].map((buffer) => ({
                  type: "input_image" as const,
                  image_url: `data:image/jpeg;base64,${buffer.toString("base64")}`,
                  detail: "high" as const,
                })),
              },
            ],
            text: { format: zodTextFormat(resultSchema, "special_visual_review") },
          },
          { signal },
        );
        onUsage({
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
          cached: false,
        });
        if (!response.output_parsed) throw new Error("特殊狀態複核沒有可解析結果");
        judgment = resultSchema.parse(response.output_parsed);
        put("vision_cache", hash, judgment);
        break;
      } catch (error) {
        const status = error instanceof OpenAI.APIError ? error.status : null;
        if (attempt === 2 || (status !== 429 && (!status || status < 500)))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }
  if (!judgment) return null;
  return {
    verdict: specialVisualConsensus(judgment),
    model,
    reason: judgment.reason,
  };
}
