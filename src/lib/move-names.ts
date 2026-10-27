// PvPoke identifiers and a few Game Master names have no zh-Hant entry in the
// current Pokémon GO text bundle. Keep these display aliases separate from the
// stored move identifiers used by battle calculations.
import { typeNames } from "./type-names";

const chineseAliases: Record<string, string> = {
  AURA_WHEEL_ELECTRIC: "氣場輪（電）",
  BEAK_BLAST: "鳥嘴加農炮",
  CHILLING_WATER: "冷水",
  DIVE: "潛水",
  DRUM_BEATING: "鼓擊",
  DYNAMAX_CANNON: "極巨炮",
  GIGATON_HAMMER: "巨力錘",
  GLAIVE_RUSH: "巨劍突擊",
  HIDDEN_POWER_FIGHTING: "覺醒力量（格鬥）",
  HIDDEN_POWER_ICE: "覺醒力量（冰）",
  HIDDEN_POWER_PSYCHIC: "覺醒力量（超能力）",
  HIDDEN_POWER_ROCK: "覺醒力量（岩石）",
  MIND_BLOWN: "驚爆大頭",
  PLASMA_FISTS: "等離子閃電拳",
  PYRO_BALL: "火焰球",
  SECRET_SWORD: "神秘之劍",
  SNIPE_SHOT: "狙擊",
  TECHNO_BLAST_DOUSE: "高科技光炮（水）",
};

const hasChinese = (value: string) => /[\u3400-\u9fff]/u.test(value);
const compactAliases = Object.fromEntries(
  Object.entries(chineseAliases).map(([id, label]) => [id.replaceAll("_", ""), label]),
);
const cleanId = (value: string) =>
  value.replace(/^AEGISLASH_CHARGE_/, "").toUpperCase();

export function moveName(
  value: string,
  names: Record<string, string> = {},
): string {
  if (hasChinese(value)) return value;
  const id = cleanId(value);
  const variants = [id, id.replaceAll("_", "")];
  for (const key of variants) {
    const translated = names[key];
    if (translated && hasChinese(translated)) return translated;
  }
  if (id.startsWith("HIDDEN_POWER_")) {
    const type = id.slice("HIDDEN_POWER_".length).toLowerCase();
    if (typeNames[type]) return `覺醒力量（${typeNames[type]}）`;
  }
  return chineseAliases[id] || compactAliases[variants[1]] || names[id] || value;
}

/** Translate identifiers already saved inside an earlier analysis sentence. */
export function localizeMoveText(
  text: string,
  names: Record<string, string> = {},
): string {
  let localized = text.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (id) =>
    moveName(id, names),
  );
  for (const [id, english] of Object.entries(names)) {
    const chinese = moveName(id, names);
    if (english !== chinese && /^[A-Za-z][A-Za-z ]+$/.test(english))
      localized = localized.replaceAll(english, chinese);
  }
  return localized;
}
