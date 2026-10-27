import type { NextRequest } from "next/server";
import { errorResponse, guard, json } from "./_handlers/http";
import { iphoneStatus, prepareIphone } from "./_handlers/iphone";
import { discardScans, listScans, scanById, startScan } from "./_handlers/scans";
import {
  executeMany,
  executeOne,
  listTransfers,
  previewTransfer,
  transferById,
} from "./_handlers/transfers";
import { appState, updateRuntimeSettings, updateSettings } from "./_handlers/state";
import { clearAll, merge, reevaluateAll, updatePokemon } from "./_handlers/pokemon";
import { refreshGameData, speciesCatalog } from "./_handlers/game-data";
import { frameImage, spriteImage } from "./_handlers/images";
import { exportData, importData } from "./_handlers/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
type Handler = (req: NextRequest) => Response | Promise<Response>;

const routes = new Map<string, Handler>([
  ["GET iphone", iphoneStatus],
  ["POST iphone/prepare", prepareIphone],
  ["GET scans", listScans],
  ["POST scans/discard", discardScans],
  ["POST scans", startScan],
  ["GET transfers", listTransfers],
  ["POST transfers", previewTransfer],
  ["POST transfers/execute-one", executeOne],
  ["POST transfers/execute-many", executeMany],
  ["GET state", appState],
  ["PATCH runtime-settings", updateRuntimeSettings],
  ["POST pokemon/clear-all", clearAll],
  ["GET species", speciesCatalog],
  ["GET export", exportData],
  ["POST import", importData],
  ["POST merge", merge],
  ["POST reevaluate", reevaluateAll],
  ["PATCH settings", updateSettings],
  ["POST data/update", refreshGameData],
]);

async function handle(req: NextRequest, ctx: Context) {
  const { path: parts } = await ctx.params,
    method = req.method;
  guard(req, method !== "GET");
  // Exact paths must win over the ID routes below, e.g. scans/discard and transfers/execute-one are not IDs.
  const exact = routes.get(`${method} ${parts.join("/")}`);
  if (exact) return exact(req);
  if (parts[0] === "scans" && parts[1]) {
    const response = await scanById(req, parts[1], parts.slice(2));
    if (response) return response;
  }
  if (parts[0] === "transfers" && parts[1]) {
    const response = await transferById(req, parts[1], parts.slice(2));
    if (response) return response;
  }
  if (method === "GET" && parts[0] === "sprites" && parts.length === 2)
    return spriteImage(req, parts[1]);
  if (method === "GET" && parts[0] === "frames")
    return frameImage(parts.slice(1).join("/"));
  if (method === "PATCH" && parts[0] === "pokemon" && parts.length === 2)
    return updatePokemon(req, parts[1]);
  return json({ error: "找不到此介面" }, 404);
}
async function respond(req: NextRequest, ctx: Context) {
  try {
    return await handle(req, ctx);
  } catch (error) {
    return errorResponse(error);
  }
}
export const GET = respond;
export const POST = respond;
export const PATCH = respond;
export const PUT = respond;
