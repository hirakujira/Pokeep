import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import sharp from "sharp";
import { z } from "zod";
import { openAiBaseURL, openAiClient } from "./openai-config";
import { spriteSlug } from "./sprites";
import { dataDir, get, put } from "./store";
import type { Species } from "./types";

const promptVersion = "shiny-two-frame-reference-v2";
const resultSchema = z.object({
  verdict: z.enum(["shiny", "normal", "uncertain"]),
  referenceDistinct: z.boolean(),
  sparklesVisible: z.boolean(),
  iconAreaClear: z.boolean(),
  shinyIconVisible: z.boolean(),
  normalColorMatch: z.boolean(),
  shinyColorMatch: z.boolean(),
  reason: z.string().max(300),
});
type Judgment = z.infer<typeof resultSchema>;

export function shinyConsensus(a: Judgment, b: Judgment) {
  if (
    a.verdict === "shiny" &&
    b.verdict === "shiny" &&
    (a.sparklesVisible || a.shinyColorMatch || a.shinyIconVisible) &&
    (b.sparklesVisible || b.shinyColorMatch || b.shinyIconVisible)
  )
    return "shiny" as const;
  if (
    a.verdict === "normal" &&
    b.verdict === "normal" &&
    a.normalColorMatch &&
    b.normalColorMatch &&
    !a.shinyColorMatch &&
    !b.shinyColorMatch &&
    !a.sparklesVisible &&
    !b.sparklesVisible &&
    !a.shinyIconVisible &&
    !b.shinyIconVisible &&
    ((a.referenceDistinct && b.referenceDistinct) ||
      (a.iconAreaClear && b.iconAreaClear))
  )
    return "normal" as const;
  return "uncertain" as const;
}

const referenceDir = path.join(dataDir, "shiny-references");
const referencePending = new Map<string, Promise<[Buffer, Buffer] | null>>();

async function pngFromUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["raw.githubusercontent.com", "pokeapi.co"].includes(parsed.hostname))
    return null;
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok || Number(response.headers.get("content-length")) > 1024 * 1024)
    return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length < 1024 * 1024 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? bytes
    : null;
}

async function referencePair(species: Species) {
  if (!/^[a-z0-9_]+$/.test(species.id)) return null;
  const normalFile = path.join(referenceDir, `${species.id}-normal.png`);
  const shinyFile = path.join(referenceDir, `${species.id}-shiny.png`);
  try {
    return [await fs.readFile(normalFile), await fs.readFile(shinyFile)] as [
      Buffer,
      Buffer,
    ];
  } catch {
    // Fetch exact references together; never use a normal sprite as a shiny fallback.
  }
  const pokemon = species.form ? spriteSlug(species) : String(species.dex);
  if (!pokemon) return null;
  const response = await fetch(
    `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(pokemon)}`,
    { cache: "no-store", signal: AbortSignal.timeout(12000) },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as {
    sprites?: { front_default?: string | null; front_shiny?: string | null };
  };
  const normalUrl = body.sprites?.front_default;
  const shinyUrl = body.sprites?.front_shiny;
  if (!normalUrl || !shinyUrl || normalUrl === shinyUrl) return null;
  const [normal, shiny] = await Promise.all([
    pngFromUrl(normalUrl),
    pngFromUrl(shinyUrl),
  ]);
  if (!normal || !shiny || normal.equals(shiny)) return null;
  await fs.mkdir(referenceDir, { recursive: true, mode: 0o700 });
  for (const [file, bytes] of [
    [normalFile, normal],
    [shinyFile, shiny],
  ] as const) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  return [normal, shiny] as [Buffer, Buffer];
}

function cachedReferences(species: Species) {
  let pending = referencePending.get(species.id);
  if (!pending) {
    pending = referencePair(species)
      .catch(() => null)
      .finally(() => referencePending.delete(species.id));
    referencePending.set(species.id, pending);
  }
  return pending;
}

async function upperImage(file: string) {
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height || meta.width >= meta.height) return null;
  const height = Math.min(Math.floor(meta.height * 0.39), meta.height);
  const maskTop = Math.floor(meta.height * 0.3);
  return sharp(file)
    .extract({ left: 0, top: 0, width: meta.width, height })
    .composite([
      {
        input: {
          create: {
            width: meta.width - Math.floor(meta.width * 0.77),
            height: height - maskTop,
            channels: 3,
            background: "#f0f4ee",
          },
        },
        left: Math.floor(meta.width * 0.77),
        top: maskTop,
      },
    ])
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function judge(
  model: string,
  images: [Buffer, Buffer],
  references: [Buffer, Buffer],
  reverse: boolean,
  signal: AbortSignal,
  onUsage: (usage: { input: number; output: number; cached: boolean }) => void,
) {
  const referenceOrder = reverse
    ? [references[1], references[0]]
    : references;
  const hash = createHash("sha256")
    .update(promptVersion)
    .update(openAiBaseURL() || "https://api.openai.com/v1")
    .update(model)
    .update(reverse ? "reverse" : "normal")
    .update(images[0])
    .update(images[1])
    .update(referenceOrder[0])
    .update(referenceOrder[1])
    .digest("hex");
  const cached = get<Judgment>("vision_cache", hash);
  if (cached) {
    onUsage({ input: 0, output: 0, cached: true });
    return cached;
  }
  const client = openAiClient({ maxRetries: 0, timeout: 90000 });
  const instruction = `判斷同一隻 Pokémon GO 的兩張畫面是否色違。前兩張是不同時間的能力頁與評價頁；第三張是${reverse ? "色違" : "一般"}像素參考圖，第四張是${reverse ? "一般" : "色違"}像素參考圖。像素圖和遊戲 3D 外觀不完全相同，請比較身體配色。先檢查 CP 上方的色違標記區：只有該區完整入鏡且清楚時 iconAreaClear=true；CP 貼著截圖上緣就填 false。shinyIconVisible 只在實際看見色違圖示時 true。色違也可能有背景中的白色四角閃光；右上角五角最愛星、CP 弧線、葉子、氣泡、火花、暗影特效與光圈不是色違證據。只有兩張外觀清楚、身體配色符合一般而不符合色違、無四角閃光，並且一般與色違參考圖可明確區分或兩張都完整拍到且未見 CP 上方色違標記時，才判 normal。任何不確定都判 uncertain。不得輸出日期、地點或玩家資訊。`;
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
              content: [...images, ...referenceOrder].map((buffer) => ({
                type: "input_image" as const,
                image_url: `data:image/${buffer.subarray(0, 4).toString("hex") === "89504e47" ? "png" : "jpeg"};base64,${buffer.toString("base64")}`,
                detail: "high" as const,
              })),
            },
          ],
          text: { format: zodTextFormat(resultSchema, "shiny_review") },
        },
        { signal },
      );
      onUsage({
        input: response.usage?.input_tokens || 0,
        output: response.usage?.output_tokens || 0,
        cached: false,
      });
      if (!response.output_parsed) throw new Error("色違複核沒有可解析結果");
      const result = resultSchema.parse(response.output_parsed);
      put("vision_cache", hash, result);
      return result;
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? error.status : null;
      if (attempt === 2 || (status !== 429 && (!status || status < 500)))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error("色違複核失敗");
}

export async function reviewShiny(
  species: Species,
  topFile: string,
  appraisalFile: string,
  signal: AbortSignal,
  onUsage: (usage: { input: number; output: number; cached: boolean }) => void,
) {
  const references = await cachedReferences(species);
  if (!references) return null;
  const [top, appraisal] = await Promise.all([
    upperImage(topFile),
    upperImage(appraisalFile),
  ]);
  if (!top || !appraisal) return null;
  const images: [Buffer, Buffer] = [top, appraisal];
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const first = await judge(model, images, references, false, signal, onUsage);
  if (first.verdict === "uncertain")
    return { verdict: "uncertain" as const, model, reason: first.reason };
  const second = await judge(model, images, references, true, signal, onUsage);
  return {
    verdict: shinyConsensus(first, second),
    model,
    reason: `${first.reason}；${second.reason}`.slice(0, 500),
    referenceHashes: references.map((bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    ),
  };
}
