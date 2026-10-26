import { createHash } from "node:crypto";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import sharp from "sharp";
import { z } from "zod";
import { resolveSpecies } from "./game-data";
import { formatOcrLines, readLocalOcr } from "./local-ocr";
import { openAiBaseURL, openAiClient } from "./openai-config";
import { getRuntimeConfig } from "./runtime-config";
import { dataDir, get, put } from "./store";
import { emptyFields, fieldsSchema, type Fields, type Snapshot } from "./types";
import { evolutionSilhouette } from "./evolution-silhouette";
import { maxStatusFromOcr, type MaxStatus } from "./max-status";

const topSchema = fieldsSchema.pick({
  name: true,
  speciesId: true,
  form: true,
  cp: true,
  hp: true,
  gender: true,
  height: true,
  weight: true,
  shadow: true,
  purified: true,
  shiny: true,
  costume: true,
  favorite: true,
});
const movesSchema = fieldsSchema.pick({
  fastMove: true,
  chargeMove: true,
  chargeMove2: true,
  candy: true,
  xlCandy: true,
  stardust: true,
  powerUpDust: true,
  powerUpCandy: true,
  evolutionCandy: true,
  secondMoveDust: true,
  secondMoveCandy: true,
  purificationDust: true,
  purificationCandy: true,
});
const resultSchema = z.object({
  top: topSchema,
  moves: movesSchema,
  appraisal: z.object({ name: fieldsSchema.shape.name, cp: fieldsSchema.shape.cp }),
  visual: z.object({
    detailClear: z.boolean(),
    hasUnexpectedOverlay: z.boolean(),
    costumeAbsentClear: z.boolean(),
    warningVisible: z.boolean(),
  }),
  issues: z.array(z.string().max(200)),
  clear: z.boolean(),
});

type Parsed = z.infer<typeof resultSchema>;
export type OcrVisionResult = {
  top: { fields: Fields; issues: string[]; clear: boolean };
  moves: { fields: Fields; issues: string[]; clear: boolean };
  appraisal: { fields: Fields; issues: string[]; clear: boolean };
  visual: Parsed["visual"] & {
    evolutionSilhouette: boolean | null;
    maxStatus: MaxStatus | null;
  };
};

const promptVersion = "pogo-local-ocr-visual-v3";
const instructions = `你是繁體中文 Pokémon GO 截圖資料校對器。輸入先由 macOS 本機 OCR 讀出三張畫面的文字，座標 [x,y] 是百分比，y 從畫面底部往上。另附一張只含能力頁上半部外觀的小圖，用來辨別物種形態、性別圖示、最愛、色違、暗影、淨化和服裝；招式與評價完整截圖沒有上傳。
嚴格只根據 OCR 及局部外觀圖輸出 schema，未看見、不確定或 OCR 含糊的欄位填 null，不得從 CP 猜 IV。局部外觀圖右側的淺色矩形是刻意遮住捕獲日期的隱私遮罩，不是遊戲彈窗，不應因此設 hasUnexpectedOverlay 或 detailClear=false。top.name 和 appraisal.name 保留原始顯示名稱，暱稱不等於物種。speciesId 若有足夠外觀證據才用 PvPoke 英文 ID，阿羅拉等形態需分清。top.hp 取最大 HP（86/86 取 86）。moves 的招式輸出中文名稱，數字 5、55 是招式威力，不是糖果。只把新攻擊招式按鈕旁的數字填 secondMoveDust/Candy。重量 kg、高度 m。特殊狀態只有相關圖示、星號、完整外觀及效果都清楚可見時才判 true/false；無法判斷就 null。最愛星號空心可判 favorite=false，實心可判 true；色違圖示區完整可見且沒有色違圖示才可判 shiny=false；暗影與淨化若完整外觀與效果區都清楚呈普通狀態才可判 false。costumeAbsentClear 只有外觀完整清楚且明確沒有服裝才 true。
OCR 文字可能錯字、漏字、把數字前的圖示辨成字元；可依同一行與位置去除明顯圖示字元，但不猜測缺失欄位。能力與評價畫面名稱或 CP 不一致、畫面遮擋、像切換中的混合畫面，clear=false 並寫 issues。資源數字若 OCR 含糊就填 null，不因這類非身分欄位設 clear=false 或寫阻擋核對的 issues。不要輸出捕獲日期、地點、玩家姓名或其他個資。IV 條由本機像素量測，不在此輸出 IV。`;

async function visualCrop(file: string) {
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height || meta.width >= meta.height)
    throw new Error("OCR 解析只支援直式 iPhone 截圖");
  const width = meta.width;
  const height = Math.floor(meta.height * 0.65);
  const maskLeft = Math.floor(width * 0.77);
  const maskTop = Math.floor(meta.height * 0.3);
  const maskBottom = Math.min(height, Math.floor(meta.height * 0.43));
  return sharp(file)
    .extract({
      left: 0,
      top: 0,
      width,
      height,
    })
    .composite([
      {
        input: {
          create: {
            width: width - maskLeft,
            height: maskBottom - maskTop,
            channels: 3,
            background: "#f0f4ee",
          },
        },
        left: maskLeft,
        top: maskTop,
      },
    ])
    .jpeg({ quality: 78 })
    .toBuffer();
}

export async function recognizeScanWithOcr(
  frames: [string, string, string],
  snapshot: Snapshot | null,
  signal: AbortSignal,
  onUsage: (usage: { input: number; output: number; cached: boolean }) => void,
): Promise<OcrVisionResult> {
  const paths = frames.map((frame) => path.join(dataDir, "frames", frame));
  const [topLines, movesLines, appraisalLines] = await readLocalOcr(paths);
  const text = [
    `能力頁 OCR:\n${formatOcrLines(topLines, "top")}`,
    `招式頁 OCR:\n${formatOcrLines(movesLines, "moves")}`,
    `評價頁 OCR:\n${formatOcrLines(appraisalLines, "appraisal")}`,
  ].join("\n\n");
  const crop = await visualCrop(paths[0]);
  const model = getRuntimeConfig().model;
  const hash = createHash("sha256")
    .update(promptVersion)
    .update(openAiBaseURL() || "https://api.openai.com/v1")
    .update(model)
    .update(snapshot?.version || "none")
    .update(text)
    .update(crop)
    .digest("hex");
  let parsed = get<Parsed>("vision_cache", hash);
  if (parsed) onUsage({ input: 0, output: 0, cached: true });
  else {
    if (!getRuntimeConfig().apiKey)
      throw new Error("尚未在網頁設定 API key，無法校對 OCR 與特殊狀態");
    const client = openAiClient({ maxRetries: 0, timeout: 90000 });
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
                  { type: "input_text", text },
                  {
                    type: "input_image",
                    image_url: `data:image/jpeg;base64,${crop.toString("base64")}`,
                    detail: "high",
                  },
                ],
              },
            ],
            text: { format: zodTextFormat(resultSchema, "pokemon_ocr_observation") },
          },
          { signal },
        );
        onUsage({
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
          cached: false,
        });
        if (!response.output_parsed)
          throw new Error("模型未回傳可解析的 OCR 校對結果");
        parsed = resultSchema.parse(response.output_parsed);
        put("vision_cache", hash, parsed);
        break;
      } catch (error) {
        const status = error instanceof OpenAI.APIError ? error.status : null;
        if (attempt === 2 || (status !== 429 && (!status || status < 500)))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }
  if (!parsed) throw new Error("OCR 校對失敗");
  const top = { ...emptyFields(), ...parsed.top };
  const moves = { ...emptyFields(), ...parsed.moves };
  const appraisal = { ...emptyFields(), ...parsed.appraisal };
  if (snapshot) {
    const species = resolveSpecies(
      snapshot,
      top.name,
      top.form,
      top.shadow,
      top.speciesId,
    );
    if (species) top.speciesId = species.id;
    else parsed.issues.push("物種／形態無法唯一對應，請人工核對");
    for (const key of ["fastMove", "chargeMove", "chargeMove2"] as const) {
      const value = moves[key];
      if (!value) continue;
      const matches = Object.values(snapshot.moves).filter(
        (move) => move.name === value || move.id === value,
      );
      if (matches.length === 1) moves[key] = matches[0].id;
    }
  }
  const result = { fields: top, issues: parsed.issues, clear: parsed.clear };
  return {
    top: result,
    moves: { fields: moves, issues: [], clear: parsed.clear },
    appraisal: { fields: appraisal, issues: [], clear: parsed.clear },
    visual: {
      ...parsed.visual,
      evolutionSilhouette: await evolutionSilhouette(paths[1], movesLines),
      maxStatus: maxStatusFromOcr(topLines),
    },
  };
}
