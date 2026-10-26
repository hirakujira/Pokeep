import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dataDir, getSnapshot } from "./store";
import type { Species } from "./types";

const spriteDir = path.join(dataDir, "sprites");
const pending = new Map<string, Promise<Buffer | null>>();

export function spriteSlug(species: Species): string | null {
  if (!species.form) return null;
  const base = species.id.replace(/_shadow$/, "");
  return base
    .replace(/_alolan$/, "-alola")
    .replace(/_galarian$/, "-galar")
    .replace(/_hisuian$/, "-hisui")
    .replace(/_paldean$/, "-paldea")
    .replaceAll("_", "-");
}

async function variantDex(species: Species) {
  const slug = spriteSlug(species);
  if (!slug) return null;
  try {
    const response = await fetch(
      `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(7000), cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: unknown };
    return Number.isInteger(body.id) && Number(body.id) > 0 && Number(body.id) <= 20000
      ? Number(body.id)
      : null;
  } catch {
    return null;
  }
}

async function downloadSprite(dex: number, shiny: boolean) {
  const suffix = shiny ? `shiny/${dex}` : String(dex);
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${suffix}.png`,
      { signal: AbortSignal.timeout(10000), cache: "no-store" },
    );
    if (!response.ok) return null;
    const size = Number(response.headers.get("content-length"));
    if (size > 1024 * 1024) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length > 1024 * 1024 ||
      bytes.length < 32 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return null;
    return bytes;
  } catch {
    return null;
  }
}

async function loadSprite(speciesId: string, shiny: boolean) {
  if (!/^[a-z0-9_]+$/.test(speciesId)) return null;
  const speciesById = getSnapshot()?.species;
  const canonicalId = speciesById?.[speciesId]
    ? speciesId
    : speciesId.replace(/_(alola|galar|hisui|paldea)$/, (_, region: string) =>
        `_${{ alola: "alolan", galar: "galarian", hisui: "hisuian", paldea: "paldean" }[region as "alola" | "galar" | "hisui" | "paldea"]}`,
      );
  const species = speciesById?.[canonicalId];
  if (!species) return null;
  const file = path.join(spriteDir, `${canonicalId}-${shiny ? "shiny" : "normal"}.png`);
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const formDex = await variantDex(species);
  const ids = [...new Set([formDex, species.dex].filter((n): n is number => !!n))];
  for (const dex of ids)
    for (const kind of shiny ? [true, false] : [false]) {
      const bytes = await downloadSprite(dex, kind);
      if (!bytes) continue;
      await fs.mkdir(spriteDir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, file);
      return bytes;
    }
  return null;
}

export function pokemonSprite(speciesId: string, shiny: boolean) {
  const key = `${speciesId}:${shiny}`;
  let result = pending.get(key);
  if (!result) {
    result = loadSprite(speciesId, shiny).finally(() => pending.delete(key));
    pending.set(key, result);
  }
  return result;
}
