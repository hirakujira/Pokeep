import fs from "node:fs/promises";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import sharp from "sharp";
import { openAiClient } from "./openai-config";

const pageSchema = z.object({
  page: z.enum([
    "collection",
    "detail",
    "appraisal",
    "menu",
    "transfer_dialog",
    "warning",
    "loading",
    "other",
  ]),
  confidence: z.number().min(0).max(1),
  title: z.string().max(120),
  visibleCount: z.number().int().min(0).max(100000).nullable(),
  sort: z.string().max(100).nullable(),
  searchQuery: z.string().max(100).nullable(),
  searchActive: z.boolean().nullable(),
  filterActive: z.boolean().nullable(),
  hasUnexpectedOverlay: z.boolean(),
  costumeAbsentClear: z.boolean(),
  warningVisible: z.boolean(),
  target: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .nullable(),
  targetClear: z.boolean(),
});
export type PhonePage = z.infer<typeof pageSchema>;
export type Target =
  | "first_pokemon"
  | "menu"
  | "appraise"
  | "advance_appraisal"
  | "close_appraisal"
  | "unfavorite"
  | "transfer"
  | "confirm_transfer"
  | "clear_search"
  | "clear_filters"
  | "search_field"
  | "back_to_collection";

let usageRecorder: ((input: number, output: number) => void) | null = null;
export function setPhoneUsageRecorder(recorder: typeof usageRecorder) {
  usageRecorder = recorder;
}

const guide = `你只辨識繁體中文 Pokémon GO iPhone 畫面和目標，不執行動作。所有 target 座標是目前截圖寬高的 0~1 比例。畫面不是明確頁面時 page=other；遮罩、活動彈窗、鍵盤或警告要標示。不要猜測列表已到底或辨識同一隻寶可夢。visibleCount 僅填明確的「寶可夢數量」數字。searchQuery 只填搜尋欄中實際可讀文字；空欄填空字串，沒看到搜尋欄填 null。costumeAbsentClear 只有完整外觀清楚且確定無服裝才能 true。warningVisible 包括放生額外警告。targetClear 只有目標唯一、可見、可點且頁面相符才能 true。找不到 target 時 target=null。`;

const targetDescriptions: Partial<Record<Target, string>> = {
  unfavorite:
    "能力頁右上角已亮起的最愛星星，點擊可取消最愛；未亮起、被遮住或無法確認時不要定位",
  advance_appraisal:
    "隊長評價畫面底部目前可見的對話框，點擊後前進一頁對話；不要點放生或其他按鈕",
  back_to_collection: "能力頁底部中央的 X 關閉按鈕",
  close_appraisal: "隊長評價畫面底部可見的 X 關閉按鈕；若被對話遮擋就不要定位",
};

export function phoneVisionBottom(target: Target | null) {
  return target &&
    [
      "menu",
      "back_to_collection",
      "close_appraisal",
      "advance_appraisal",
    ].includes(target)
    ? 0.985
    : 0.92;
}

export async function inspectPhoneImage(
  file: string,
  target: Target | null,
  redactLocation = false,
): Promise<PhonePage> {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("自動掃描需要 OPENAI_API_KEY");
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height || meta.width >= meta.height)
    throw new Error("僅支援直式 iPhone 畫面");
  const top = Math.floor(meta.height * 0.055),
    bottom = Math.floor(meta.height * phoneVisionBottom(target));
  let imagePipeline = sharp(await fs.readFile(file)).extract({
    left: 0,
    top,
    width: meta.width,
    height: bottom - top,
  });
  if (redactLocation) {
    const maskTop = Math.floor(meta.height * 0.71) - top;
    const maskBottom = Math.floor(meta.height * 0.89) - top;
    imagePipeline = imagePipeline.composite([
      {
        input: {
          create: {
            width: meta.width,
            height: maskBottom - maskTop,
            channels: 3,
            background: "#f0f4ee",
          },
        },
        left: 0,
        top: maskTop,
      },
    ]);
  }
  const image = await imagePipeline.jpeg({ quality: 85 }).toBuffer();
  const client = openAiClient({
    maxRetries: 1,
    timeout: 90000,
  });
  const response = await client.responses.parse({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    store: false,
    input: [
      { role: "system", content: guide },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${redactLocation ? "畫面下方的淺色矩形是為隱私遮蔽捕獲地點，不是遊戲彈窗，不要因此設定 hasUnexpectedOverlay。" : ""}${target ? `判斷畫面；定位目標 ${target}：${targetDescriptions[target] || target}。僅在目標真的可見時提供座標。` : "判斷畫面與數量；不需定位目標。"}`,
          },
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${image.toString("base64")}`,
            detail: "high",
          },
        ],
      },
    ],
    text: { format: zodTextFormat(pageSchema, "pokemon_go_phone_page") },
  });
  usageRecorder?.(
    response.usage?.input_tokens || 0,
    response.usage?.output_tokens || 0,
  );
  if (!response.output_parsed) throw new Error("手機畫面無法辨識");
  return pageSchema.parse(response.output_parsed);
}
