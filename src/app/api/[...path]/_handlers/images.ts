import type { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/store";
import { validFrame } from "@/lib/backup";
import { pokemonSprite } from "@/lib/sprites";
import { json } from "./http";

export async function spriteImage(req: NextRequest, speciesId: string) {
  const sprite = await pokemonSprite(
    speciesId,
    req.nextUrl.searchParams.get("shiny") === "1",
  );
  if (!sprite) return json({ error: "找不到像素圖" }, 404);
  return new Response(new Uint8Array(sprite), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function frameImage(frame: string) {
  if (!validFrame(frame)) return json({ error: "無效截圖路徑" }, 400);
  try {
    const image = await fs.readFile(path.join(dataDir, "frames", frame));
    return new Response(image, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return json({ error: "來源截圖不存在" }, 404);
  }
}
