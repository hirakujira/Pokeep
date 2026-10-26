import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fixture, species } from "./fixtures";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pokekeep-sprites-test-"));
(globalThis as typeof globalThis & { __POGO_TEST_DATA_DIR__?: string }).__POGO_TEST_DATA_DIR__ = temp;
const store = await import("../src/lib/store");
const { pokemonSprite, spriteSlug } = await import("../src/lib/sprites");
after(() => {
  store.db().close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("地區形態優先下載對應像素圖，快取後不再查詢", async () => {
  const snapshot = fixture();
  snapshot.species.rattata_alolan = species("rattata_alolan", {
    dex: 19,
    form: "(Alolan)",
  });
  snapshot.species.wooper_paldean = species("wooper_paldean", {
    dex: 194,
    form: "(Paldean)",
  });
  store.saveSnapshot(snapshot);
  assert.equal(spriteSlug(snapshot.species.rattata_alolan), "rattata-alola");
  const png = await sharp({
    create: { width: 4, height: 4, channels: 4, background: "#7a477a" },
  })
    .png()
    .toBuffer();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://pokeapi.co/api/v2/pokemon/rattata-alola")
      return Response.json({ id: 10091 });
    if (url === "https://pokeapi.co/api/v2/pokemon/wooper-paldea")
      return Response.json({ id: 10253 });
    if (url.endsWith("/sprites/pokemon/shiny/10091.png"))
      return new Response(new Uint8Array(png), {
        headers: { "Content-Type": "image/png" },
      });
    if (url.endsWith("/sprites/pokemon/10253.png"))
      return new Response(new Uint8Array(png), {
        headers: { "Content-Type": "image/png" },
      });
    throw new Error(`意外的圖檔來源：${url}`);
  };
  try {
    assert.deepEqual(await pokemonSprite("rattata_alolan", true), png);
    assert.deepEqual(await pokemonSprite("rattata_alolan", true), png);
    assert.deepEqual(await pokemonSprite("wooper_paldea", false), png);
    assert.equal(await pokemonSprite("../unknown", false), null);
    assert.deepEqual(urls, [
      "https://pokeapi.co/api/v2/pokemon/rattata-alola",
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/shiny/10091.png",
      "https://pokeapi.co/api/v2/pokemon/wooper-paldea",
      "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/10253.png",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
