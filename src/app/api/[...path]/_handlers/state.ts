import type { NextRequest } from "next/server";
import { getSettings, listPokemon, put } from "@/lib/store";
import { settingsSchema } from "@/lib/types";
import { reevaluate } from "@/lib/evaluate";
import { publicSnapshot } from "@/lib/game-data";
import { activeBatch, activeScan } from "@/lib/iphone-data";
import { publicRuntimeConfig, saveRuntimeConfig } from "@/lib/runtime-config";
import { body, json } from "./http";

export function appState() {
  const runtime = publicRuntimeConfig();
  return json({
    pokemon: listPokemon(),
    settings: getSettings(),
    snapshot: publicSnapshot(),
    apiConfigured: runtime.apiConfigured,
    model: runtime.model,
    runtime,
  });
}
export async function updateRuntimeSettings(req: NextRequest) {
  if (activeScan() || activeBatch())
    throw new Error("手機工作執行中，請完成或暫停後再修改連線設定");
  return json(saveRuntimeConfig(await body(req)));
}
export async function updateSettings(req: NextRequest) {
  const settings = settingsSchema.parse(await body(req));
  put("settings", "preferences", settings);
  reevaluate();
  return json(settings);
}
