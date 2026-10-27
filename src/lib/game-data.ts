import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataDir, getSnapshot, saveSnapshot } from "./store";
import type { Fields, Gender, Snapshot, Species, VisualForm } from "./types";
import { localizedMoveAliases, moveName } from "./move-names";
import { typeName } from "./type-names";

const urls: Record<string, string> = {
  "pvpoke.json":
    "https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/gamemaster.json",
  "game-master.json":
    "https://raw.githubusercontent.com/PokeMiners/game_masters/master/latest/latest.json",
  "zh-Hant.txt":
    "https://raw.githubusercontent.com/PokeMiners/pogo_assets/master/Texts/Latest%20APK/ChineseTraditional.txt",
  ...Object.fromEntries(
    [1500, 2500, 10000].map((cp) => [
      `rankings-${cp}.json`,
      `https://raw.githubusercontent.com/pvpoke/pvpoke/master/src/data/rankings/all/overall/rankings-${cp}.json`,
    ]),
  ),
};
// Raw upstream formats are deliberately isolated from the application's typed snapshot.
type Raw = Record<string, any>; // eslint-disable-line
function parseTexts(text: string) {
  const entries: Record<string, string> = {};
  for (const match of text.matchAll(
    /RESOURCE ID: ([^\r\n]+)\r?\nTEXT: ([^\r\n]+)/g,
  ))
    entries[match[1]] = match[2];
  return entries;
}
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/_shadow$/, " ")
    .trim()
    .replace(/_normal$/, " ")
    .trim()
    .replace(/alolan/g, "alola")
    .replace(/galarian/g, "galar")
    .replace(/hisuian/g, "hisui")
    .replace(/paldean/g, "paldea");
// PvPoke spells a few Game Master move IDs differently (FUTURE_SIGHT for
// FUTURESIGHT, TECHNO_BLAST_DOUSE for TECHNO_BLAST_WATER) and models Aegislash's
// Shield-form fast moves as separate moves.
const compactMove = (id: string) =>
  id
    .replace(/_FAST$/, "")
    .replace(/^AEGISLASH_CHARGE_/, "")
    .replace(/^TECHNO_BLAST_DOUSE$/, "TECHNO_BLAST_WATER")
    .replace(/_/g, "");
// Wrap variants no Pokémon learns; the Game Master still lists them.
const unusedVariantLabels: Record<string, string> = { GREEN: "綠色", PINK: "粉紅色" };
// PvPoke marks these available, special-case Pokémon as unreleased because
// ordinary PvP simulations do not cover them. They still belong in the catalog.
const catalogExceptions = new Set(["ditto", "shedinja", "cosmog", "cosmoem"]);
// PvPoke misspells Dusk Form Lycanroc in Rockruff's evolution list.
const evolutionIdFixes: Record<string, string> = { lycranroc_dusk: "lycanroc_dusk" };
// GO's zh-Hant text has no names past #1008; these come from the official Taiwan Pokédex.
const missingSpeciesNames: Record<number, string> = {
  1011: "裹蜜蟲",
  1012: "斯魔茶",
  1013: "來悲粗茶",
  1019: "蜜集大蛇",
};

export function addCatalogForms(species: Snapshot["species"]) {
  const aliases: Record<string, { base: string; form: string | null }> = {
    nidoran_m: { base: "nidoran_male", form: null },
    squawkabilly_blue: { base: "squawkabilly", form: "藍羽" },
    squawkabilly_green: { base: "squawkabilly", form: "綠羽" },
    squawkabilly_white: { base: "squawkabilly", form: "白羽" },
    squawkabilly_yellow: { base: "squawkabilly", form: "黃羽" },
  };
  for (const [id, { base, form }] of Object.entries(aliases)) {
    const parent = species[base];
    if (!parent || species[id]) continue;
    species[id] = {
      ...parent,
      id,
      name: form ? `${parent.name}（${form}）` : parent.name,
      form,
    };
  }
}
// Labels the Traditional Chinese text file lacks, or files under a generic
// key that belongs to another species (form_blue is Squawkabilly's plumage).
const visualFormLabels: Record<string, string> = {
  EXCLAMATION_POINT: "!",
  QUESTION_MARK: "?",
  MINIOR_RED: "紅色核心",
  MINIOR_ORANGE: "橙色核心",
  MINIOR_YELLOW: "黃色核心",
  MINIOR_GREEN: "綠色核心",
  MINIOR_BLUE: "淺藍色核心",
  MINIOR_INDIGO: "藍色核心",
  MINIOR_VIOLET: "紫色核心",
  MAGEARNA_ORIGINAL_COLOR: "500年前的顏色",
  POLTCHAGEIST_COUNTERFEIT: "冒牌貨的樣子",
  POLTCHAGEIST_ARTISAN: "高檔貨的樣子",
  SINISTCHA_UNREMARKABLE: "凡作的樣子",
  SINISTCHA_MASTERPIECE: "傑作的樣子",
  TOXTRICITY_AMPED: "高調的樣子",
  TOXTRICITY_LOW_KEY: "低調的樣子",
};
// In-battle form changes; a caught Pokémon never keeps them.
const battleOnlyForms = new Set([
  "AEGISLASH_BLADE", "MELOETTA_PIROUETTE", "MIMIKYU_BUSTED", "CRAMORANT_GULPING",
  "CRAMORANT_GORGING", "MORPEKO_HANGRY", "ETERNATUS_ETERNAMAX",
]);
// Pre-evolutions share their evolution's pattern names.
const visualFormTextOwner: Record<string, string> = {
  SCATTERBUG: "VIVILLON",
  SPEWPA: "VIVILLON",
};
function visualFormLabel(pokemon: string, suffix: string, tr: Record<string, string>) {
  const text = (key: string) => {
    const value = tr[`form_${key.toLowerCase()}`]?.trim();
    return value && /[^\x00-\x7F]/.test(value) ? value : undefined;
  };
  return visualFormLabels[`${pokemon}_${suffix}`] ?? visualFormLabels[suffix] ??
    text(`${pokemon}_${suffix}`) ??
    (visualFormTextOwner[pokemon] && text(`${visualFormTextOwner[pokemon]}_${suffix}`)) ??
    text(suffix) ??
    (/^\d+$/.test(suffix) ? `花紋 ${Number(suffix) + 1}` : suffix);
}
/**
 * Appearance-only forms (Shellos seas, Unown letters, Vivillon patterns…) share
 * one battle species, so PvPoke has no IDs for them. Species with several
 * catalog IDs already list their forms through those IDs.
 */
export function visualFormsByDex(
  gm: Raw[],
  tr: Record<string, string>,
  species: Snapshot["species"],
) {
  const variants = new Map<number, number>();
  for (const s of Object.values(species))
    if (!s.id.endsWith("_shadow")) variants.set(s.dex, (variants.get(s.dex) ?? 0) + 1);
  const result: Record<string, VisualForm[]> = {};
  for (const row of gm) {
    const settings = row.data?.formSettings,
      dex = Number(row.templateId?.match(/^FORMS_V(\d+)_POKEMON_/)?.[1]);
    if (!Array.isArray(settings?.forms) || variants.get(dex) !== 1) continue;
    const pokemon: string = settings.pokemon;
    let normal = false;
    const forms: (VisualForm & { order: number })[] = [];
    for (const form of settings.forms) {
      if (typeof form.form !== "string" || form.isCostume) continue;
      const suffix = form.form.startsWith(`${pokemon}_`)
        ? form.form.slice(pokemon.length + 1)
        : form.form;
      if (form.form.endsWith("_NORMAL") || suffix === "NORMAL") {
        normal = true;
        continue;
      }
      // Gender art, event clones, dated event models and the shadow-legend
      // "_S" models are not forms a player tells apart in the collection.
      if (suffix === "FEMALE" || suffix === "COPY_2019" || /_\d{4}$/.test(suffix) ||
          (suffix === "S" && pokemon !== "UNOWN") || battleOnlyForms.has(form.form))
        continue;
      forms.push({
        id: suffix.toLowerCase(),
        label: visualFormLabel(pokemon, suffix, tr),
        order: form.assetBundleValue ?? Number.MAX_SAFE_INTEGER,
      });
    }
    if (forms.length + Number(normal) < 2) continue;
    forms.sort((a, b) => a.order - b.order);
    result[dex] = [
      ...(normal ? [{ id: "normal", label: "一般" }] : []),
      ...forms.map(({ id, label }) => ({ id, label })),
    ];
  }
  return result;
}
/** Every gender any Game Master spawn entry of a dex can have, in a fixed order. */
export function gendersByDex(gm: Raw[]) {
  const seen = new Map<number, Set<Gender>>();
  for (const row of gm) {
    const dex = row.templateId?.match(/^SPAWN_V(\d+)_POKEMON_/);
    const gender = row.data?.genderSettings?.gender;
    if (!dex || !gender) continue;
    const set = seen.get(Number(dex[1])) ?? new Set<Gender>();
    if (gender.malePercent) set.add("male");
    if (gender.femalePercent) set.add("female");
    if (gender.genderlessPercent) set.add("genderless");
    seen.set(Number(dex[1]), set);
  }
  const order: Gender[] = ["male", "female", "genderless"];
  return new Map(
    [...seen].filter(([, set]) => set.size).map(([dex, set]) => [dex, order.filter((g) => set.has(g))]),
  );
}
// Gender forms such as meowstic_female have their own IDs; the plain ID is the male form.
function speciesGenders(id: string, dexGenders: Gender[] | undefined, ids: Set<string>) {
  const base = id.replace(/_shadow$/, "");
  const form = base.match(/_(male|female)$/)?.[1] as Gender | undefined;
  if (form) return [form];
  return ids.has(`${base}_female`) ? ["male" as const] : dexGenders;
}
export function normalizeData(
  pvp: Raw,
  gm: Raw[],
  texts: string,
  ranks: Record<string, Raw[]>,
  version: string,
): Snapshot {
  if (
    !Array.isArray(pvp.pokemon) ||
    pvp.pokemon.length < 100 ||
    !Array.isArray(gm)
  )
    throw new Error("遊戲資料格式不符，已保留舊版本");
  const tr = parseTexts(texts),
    gmPokemon = new Map<string, Raw>();
  const dexGenders = gendersByDex(gm),
    pvpIds = new Set<string>(pvp.pokemon.map((p: Raw) => p.speciesId)),
    // Either source can list a Mega the other lacks, such as PvPoke's Staraptor.
    pvpMegaBases = new Set<string>(
      pvp.pokemon
        .filter((p: Raw) => p.tags?.includes("mega"))
        .map((p: Raw) => p.speciesId.replace(/_(mega(_[xy])?|primal)$/, "")),
    );
  for (const row of gm)
    if (row.data?.pokemonSettings)
      gmPokemon.set(
        norm(row.templateId.replace(/^V\d+_POKEMON_/, "")),
        row.data.pokemonSettings,
      );
  // Max Battles are "bread" in the Game Master: a species gets Max models only
  // once it can Dynamax, and the "dough" models are its Gigantamax form.
  // Zacian and Zamazenta carry Max moves through their form change instead.
  const maxModes = new Map<string, Set<string>>();
  const addMaxMode = (key: string, mode: unknown) => {
    if (typeof mode !== "string") return;
    maxModes.set(key, (maxModes.get(key) ?? new Set<string>()).add(mode));
  };
  for (const row of gm) {
    const overrides = row.data?.pokemonExtendedSettings?.breadOverrides;
    if (Array.isArray(overrides))
      for (const o of overrides)
        addMaxMode(norm(row.templateId.replace(/^EXTENDED_V\d+_POKEMON_/, "")), o.breadMode);
    if (row.data?.pokemonSettings?.formChange?.some((c: Raw) => c.requiredBreadMoves ||
        c.formChangeBonusAttributes?.some((a: Raw) => a.breadMode || a.clearBreadMode)))
      addMaxMode(norm(row.templateId.replace(/^V\d+_POKEMON_/, "")), "BREAD_SPECIAL_MODE");
  }
  const maxForms = (id: string) => {
    if (!maxModes.size) return undefined;
    const modes = [...(maxModes.get(norm(id)) ?? [])];
    return [
      ...(modes.length ? ["dynamax" as const] : []),
      ...(modes.some((m) => m.startsWith("BREAD_DOUGH_MODE")) ? ["gigantamax" as const] : []),
    ];
  };
  const species: Snapshot["species"] = {},
    names: Record<string, string> = {},
    moveNames: Record<string, string> = {},
    poolGaps: [string, string[]][] = [];
  const moves: Snapshot["moves"] = {};
  for (const row of gm) {
    const m = row.data?.moveSettings;
    const numeric = row.templateId.match(/^V(\d+)_MOVE_(.+)$/);
    // Newer moves carry a numeric movementId; their template ID still names them.
    const rawId = typeof m?.movementId === "string" ? m.movementId : numeric?.[2];
    if (!m || !m.durationMs || !rawId) continue;
    const moveId = rawId.replace(/_FAST$/, "");
    const name = numeric ? tr[`move_name_${numeric[1]}`] : null;
    moveNames[moveId] = moveName(
      moveId,
      { [moveId]: name || pvp.moves.find((v: Raw) => v.moveId === moveId)?.name || moveId },
    );
    moves[moveId] = {
      id: moveId,
      name: moveNames[moveId],
      type: (m.pokemonType || "").replace("POKEMON_TYPE_", "").toLowerCase(),
      power: m.power || 0,
      energy: m.energyDelta || 0,
      duration: m.durationMs / 1000,
    };
  }
  // The game rolls Hidden Power's type per Pokémon; PvPoke keeps one ID per type.
  for (const pm of pvp.moves)
    if (moves.HIDDEN_POWER && pm.moveId.startsWith("HIDDEN_POWER_")) {
      moveNames[pm.moveId] = moveName(pm.moveId);
      moves[pm.moveId] = { ...moves.HIDDEN_POWER, id: pm.moveId, name: moveNames[pm.moveId], type: pm.type };
    }
  // Moves sharing one in-game name: a Pokémon's own version reads 水槍（水箭龜專屬）
  // and typed versions carry their type, while the ordinary or Normal-type one
  // keeps the plain name.
  const dexByPokemon = new Map<string, string>();
  for (const row of gm) {
    const match = row.templateId.match(/^V(\d{4})_POKEMON_([A-Z0-9_]+)$/);
    if (match && !dexByPokemon.has(match[2])) dexByPokemon.set(match[2], match[1]);
  }
  const sameName = new Map<string, Snapshot["moves"][string][]>();
  for (const m of Object.values(moves)) sameName.set(m.name, [...(sameName.get(m.name) ?? []), m]);
  for (const group of sameName.values()) {
    if (group.length < 2) continue;
    const typed = new Set(group.map((m) => m.type)).size > 1;
    for (const m of group) {
      const suffix = m.id.split("_").at(-1)!;
      const dex = dexByPokemon.get(suffix);
      const label = dex
        ? `${tr[`pokemon_name_${dex}`] ?? suffix}專屬`
        : unusedVariantLabels[suffix] ?? (typed && m.type !== "normal" ? typeName(m.type) : null);
      if (label) moveNames[m.id] = m.name = `${m.name}（${label}）`;
    }
  }
  const gmMoveIds = new Map(Object.keys(moves).map((id) => [compactMove(id), id]));
  const gmMove = (id: string) => (moves[id] ? id : gmMoveIds.get(compactMove(id)) ?? id);
  const gmMoves = (ids: string[] = []) => [...new Set(ids.map(gmMove))];
  for (const p of pvp.pokemon) {
    if ((p.released === false && !catalogExceptions.has(p.speciesId)) ||
        !p.baseStats || p.tags?.includes("mega"))
      continue;
    const baseId = p.speciesId.replace(/_shadow$/, ""),
      g = gmPokemon.get(norm(baseId));
    const zh =
      tr[`pokemon_name_${String(p.dex).padStart(4, "0")}`] ||
      missingSpeciesNames[p.dex] ||
      p.speciesName;
    const suffix =
      p.speciesName
        .match(/\(.+\)/)?.[0]
        ?.replace(/ \(Shadow\)/, "")
        .replace("(Shadow)", "") || "";
    const name =
      zh +
      (suffix ? ` ${suffix}` : "") +
      (p.tags?.includes("shadow") ? "（暗影）" : "");
    const fast = gmMoves(p.fastMoves), charged = gmMoves(p.chargedMoves), elite = gmMoves(p.eliteMoves);
    // The Game Master pool shows a move change before PvPoke picks it up; moves
    // only PvPoke lists are mostly legacy moves the Game Master already dropped.
    if (g && !p.speciesId.endsWith("_shadow")) {
      const poolKey = (id: string) => compactMove(id.replace(/^HIDDEN_POWER_.+/, "HIDDEN_POWER"));
      const known = new Set([...fast, ...charged, ...elite].map(poolKey));
      const missing = [
        ...(g.quickMoves || []), ...(g.cinematicMoves || []),
        ...(g.eliteQuickMove || []), ...(g.eliteCinematicMove || []),
      ].filter((m) => typeof m === "string" && !/^\d+$/.test(m))
        .map((m: string) => m.replace(/_FAST$/, ""))
        .filter((m: string) => !known.has(poolKey(m)));
      if (missing.length) poolGaps.push([p.speciesId, [...new Set<string>(missing)]]);
    }
    const branches = g?.evolutionBranch || [],
      used = new Set<Raw>();
    const evolutions = (p.family?.evolutions || []).map((listed: string) => {
      const e = evolutionIdFixes[listed] ?? listed;
      // PvPoke lists a gender split such as Lechonk's once per gender under the
      // plain ID, so each listing takes the next branch that is still free.
      const free = branches.filter((b: Raw) => !used.has(b));
      const shared =
        free.find(
          (b: Raw) => norm(b.form || b.evolution || "") === norm(e),
        ) ||
        free.find((b: Raw) => norm(b.evolution || "") === norm(e)) ||
        (branches.length === 1 ? branches[0] : null);
      // A branch only one form can take, such as Own Tempo Rockruff's Dusk
      // Form, sits under that form's own Game Master entry.
      const formOnly = shared ? null : [...gmPokemon]
        .filter(([key]) => key.startsWith(`${norm(baseId)}_`))
        .flatMap(([, settings]) => settings.evolutionBranch || [])
        .find((b: Raw) => norm(b.form || "") === norm(e));
      const branch = shared || formOnly;
      if (branch) used.add(branch);
      const female = `${e}_female`;
      const id = branch?.genderRequirement === "FEMALE" && pvpIds.has(female) &&
        norm(branch.form || "") === female ? female : e;
      const conditions: string[] = formOnly ? ["只有特定形態的個體能進化"] : [];
      if (branch) {
        if (branch.evolutionItemRequirement)
          conditions.push(`需要進化道具 ${branch.evolutionItemRequirement}`);
        if (branch.genderRequirement)
          conditions.push(`性別限制 ${branch.genderRequirement}`);
        if (branch.buddyDistanceRequirement)
          conditions.push(`夥伴步行 ${branch.buddyDistanceRequirement} km`);
        if (
          branch.onlyNighttime ||
          branch.onlyDaytime ||
          branch.onlyDuskPeriod ||
          branch.timeOfDayRequirement
        )
          conditions.push("有時段限制");
        if (branch.questDisplay) conditions.push("須完成進化任務");
        const known = new Set([
          "evolution",
          "form",
          "candyCost",
          "candyCostPurified",
          "noCandyCostViaTrade",
          "evolutionItemRequirement",
          "genderRequirement",
          "buddyDistanceRequirement",
          "onlyNighttime",
          "onlyDaytime",
          "onlyDuskPeriod",
          "timeOfDayRequirement",
          "questDisplay",
          "lureItemRequirement",
        ]);
        if (Object.keys(branch).some((k) => !known.has(k)))
          conditions.push("有額外進化條件，請核對遊戲");
        if (branch.lureItemRequirement) conditions.push("需要特定誘餌模組");
      } else conditions.push("進化成本／條件資料不足，請核對遊戲");
      return {
        id,
        candy: branch?.candyCost ?? g?.candyToEvolve ?? 0,
        candyPurified: branch?.candyCostPurified,
        condition: conditions.length ? conditions.join("；") : null,
        gender: branch?.genderRequirement?.includes("FEMALE")
          ? "female"
          : branch?.genderRequirement?.includes("MALE")
            ? "male"
            : undefined,
      };
    });
    const tags = [...(p.tags || [])],
      genders = speciesGenders(p.speciesId, dexGenders.get(p.dex), pvpIds);
    if (g?.pokemonClass?.includes("LEGENDARY")) tags.push("legendary");
    if (g?.pokemonClass?.includes("MYTHIC")) tags.push("mythical");
    species[p.speciesId] = {
      id: p.speciesId,
      dex: p.dex,
      name,
      genderless: genders?.length === 1 && genders[0] === "genderless",
      genders,
      types: p.types.filter((t: string) => t !== "none"),
      atk: p.baseStats.atk,
      def: p.baseStats.def,
      sta: p.baseStats.hp,
      fast,
      charged,
      elite,
      tags: [...new Set(tags)] as string[],
      evolutions,
      mega: pvpMegaBases.has(baseId) ||
        Boolean(g?.tempEvoOverrides?.some((o: Raw) => o.tempEvoId)),
      maxForms: maxForms(baseId),
      // Smeargle cannot unlock a second move; it lists only an unreachable candy cost.
      thirdMove: g?.thirdMove?.stardustToUnlock
        ? {
            dust: g.thirdMove.stardustToUnlock,
            candy: g.thirdMove.candyToUnlock,
          }
        : null,
      purification: g?.shadow
        ? {
            dust: g.shadow.purificationStardustNeeded,
            candy: g.shadow.purificationCandyNeeded,
          }
        : undefined,
      form: suffix || null,
    };
    names[p.speciesId] = name;
  }
  addCatalogForms(species);
  for (const [id, entry] of Object.entries(species)) names[id] = entry.name;
  const cpm = gm.find((r) => r.templateId === "PLAYER_LEVEL_SETTINGS")?.data
    ?.playerLevel?.cpMultiplier;
  const upgrades = gm.find((r) => r.templateId === "POKEMON_UPGRADE_SETTINGS")
    ?.data?.pokemonUpgrades;
  if (!Array.isArray(cpm) || cpm.length < 51 || !upgrades?.stardustCost)
    throw new Error("CP／成本資料不完整，已保留舊版本");
  const rankings: Snapshot["rankings"] = {};
  for (const [league, rows] of Object.entries(ranks)) {
    if (!Array.isArray(rows) || rows.length < 100)
      throw new Error(`${league} 聯盟排名格式不符`);
    rankings[league] = rows.map((r) => ({
      speciesId: r.speciesId,
      score: r.score,
      moves: (r.moveset || []).map(gmMove),
    }));
  }
  return {
    version,
    updatedAt: new Date().toISOString(),
    sourceDate: pvp.timestamp || "未知",
    sources: Object.entries(urls).map(([file, url]) => ({
      name: file,
      url,
      version,
    })),
    species,
    moves,
    rankings,
    cpm,
    powerups: {
      dust: upgrades.stardustCost,
      candy: upgrades.candyCost,
      xl: upgrades.xlCandyCost,
    },
    names,
    moveNames,
    visualForms: visualFormsByDex(gm, tr, species),
    warnings: [
      "PvE 為簡化中性循環 DPS，不是指定頭目的實戰排名。",
      "資料來源 Game Master 可能含未確認欄位；活動開放狀態需核對遊戲。",
      "特殊物種的專屬強化成本及進化任務請核對遊戲；成本標為估算。",
      ...(poolGaps.length
        ? [
            `Game Master 招式池有、PvPoke 尚未收錄（遊戲可能剛調整，評估仍以 PvPoke 為準）：${poolGaps
              .map(([id, moves]) => `${names[id]} ${moves.map((m) => moveNames[m] ?? m).join("、")}`)
              .join("；")}`,
          ]
        : []),
    ],
  };
}
let activeUpdate: Promise<Snapshot> | null = null;
export function updateGameData(useCache = false): Promise<Snapshot> {
  if (activeUpdate) return activeUpdate;
  activeUpdate = (async () => {
    const dir = path.join(dataDir, "source");
    await fs.mkdir(dir, { recursive: true });
    const content: Record<string, string> = {};
    await Promise.all(
      Object.entries(urls).map(async ([name, url]) => {
        if (useCache) {
          try {
            content[name] = await fs.readFile(path.join(dir, name), "utf8");
            return;
          } catch {}
        }
        const response = await fetch(url, {
          signal: AbortSignal.timeout(45000),
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(`無法更新 ${name}（HTTP ${response.status}）`);
        content[name] = await response.text();
        if (content[name].length < 100) throw new Error(`${name} 資料異常`);
      }),
    );
    const hash = createHash("sha256");
    for (const name of Object.keys(urls).sort()) hash.update(content[name]);
    const version = hash.digest("hex").slice(0, 16);
    const snapshot = normalizeData(
      JSON.parse(content["pvpoke.json"]),
      JSON.parse(content["game-master.json"]),
      content["zh-Hant.txt"],
      Object.fromEntries(
        [1500, 2500, 10000].map((cp) => [
          String(cp),
          JSON.parse(content[`rankings-${cp}.json`]),
        ]),
      ),
      version,
    );
    // Publish only after every source has passed validation; a failed refresh leaves the previous snapshot active.
    for (const [name, text] of Object.entries(content))
      await fs.writeFile(path.join(dir, name), text);
    saveSnapshot(snapshot);
    return snapshot;
  })().finally(() => {
    activeUpdate = null;
  });
  return activeUpdate;
}
export function resolveSpecies(
  snapshot: Snapshot,
  name: string | null,
  form: string | null,
  shadow: boolean | null,
  providedId: string | null,
  moves?: Pick<Fields, "fastMove" | "chargeMove" | "chargeMove2">,
): Species | null {
  if (providedId && snapshot.species[providedId]) {
    const wanted =
      shadow === true
        ? providedId.replace(/_shadow$/, "") + "_shadow"
        : shadow === false
          ? providedId.replace(/_shadow$/, "")
          : providedId;
    return snapshot.species[wanted] || null;
  }
  if (!name) return null;
  const candidates = Object.values(snapshot.species).filter(
    (s) => s.name.split(" ")[0] === name || s.id === name.toLowerCase(),
  );
  const isForm = (s: Species) =>
    !form || form === "normal" || form === "一般"
      ? !s.form
      : /^(一般|普通)(形態|型態)$/.test(form)
        ? s.id.replace(/_shadow$/, "").endsWith("_standard")
      : s.id.includes(form.toLowerCase().replace("alola", "alolan")) ||
        s.form?.toLowerCase().includes(form.toLowerCase());
  const exact = candidates.filter(
    (s) => Boolean(s.tags.includes("shadow")) === Boolean(shadow) && isForm(s),
  );
  if (exact.length === 1) return exact[0];
  if (!moves || exact.length < 2) return null;
  const observed = [moves.fastMove, moves.chargeMove, moves.chargeMove2]
    .filter((move): move is string => Boolean(move));
  if (!observed.length) return null;
  const compatible = exact.filter((species) =>
    (!moves.fastMove || [...species.fast, ...species.elite].includes(moves.fastMove)) &&
    [moves.chargeMove, moves.chargeMove2].every((move) =>
      !move || [...species.charged, ...species.elite].includes(move),
    ),
  );
  return compatible.length === 1 ? compatible[0] : null;
}
/**
 * Screenshots show the in-game name, which several moves can share (Blastoise's
 * own Water Gun, the typed Weather Balls); the species' pool picks among those,
 * then the move whose name has no added label. An unresolved name is kept as read.
 */
export function resolveMoveId(snapshot: Snapshot, value: string, species?: Species | null) {
  const id = localizedMoveAliases[value] ?? value;
  if (snapshot.moves[id]) return id;
  const named = Object.values(snapshot.moves).filter(
    (m) => m.name === value || m.name.replace(/（[^）]*）$/, "") === value,
  );
  if (named.length === 1) return named[0].id;
  const pool = new Set([...(species?.fast ?? []), ...(species?.charged ?? []), ...(species?.elite ?? [])]);
  const inPool = named.filter((m) => pool.has(m.id));
  if (inPool.length === 1) return inPool[0].id;
  const exact = named.filter((m) => m.name === value);
  return exact.length === 1 ? exact[0].id : value;
}
export function publicSnapshot(snapshot = getSnapshot()) {
  return snapshot
    ? {
        version: snapshot.version,
        updatedAt: snapshot.updatedAt,
        sourceDate: snapshot.sourceDate,
        sources: snapshot.sources,
        count: Object.keys(snapshot.species).length,
        warnings: snapshot.warnings,
      }
    : null;
}
