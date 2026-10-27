import { z } from "zod";
import type { MaxStatus } from "./max-status";
import { speciesCostume } from "./species-names";

const numberOrNull = z.number().finite().nonnegative().nullable();
const textOrNull = z.string().max(160).nullable();
const iv = z.number().int().min(0).max(15).nullable();
export const fieldsSchema = z.object({
  name: textOrNull,
  speciesId: textOrNull,
  form: textOrNull,
  cp: z.number().int().min(10).max(15000).nullable(),
  hp: z.number().int().min(1).max(2000).nullable(),
  gender: z.enum(["male", "female", "genderless"]).nullable(),
  height: numberOrNull,
  weight: numberOrNull,
  shadow: z.boolean().nullable(),
  purified: z.boolean().nullable(),
  shiny: z.boolean().nullable(),
  costume: textOrNull,
  favorite: z.boolean().nullable(),
  ivAtk: iv,
  ivDef: iv,
  ivSta: iv,
  fastMove: textOrNull,
  chargeMove: textOrNull,
  chargeMove2: textOrNull,
  candy: numberOrNull,
  xlCandy: numberOrNull,
  stardust: numberOrNull,
  powerUpDust: numberOrNull,
  powerUpCandy: numberOrNull,
});
export type Fields = z.infer<typeof fieldsSchema>;
export type Gender = NonNullable<Fields["gender"]>;
export const emptyFields = (): Fields =>
  Object.fromEntries(
    Object.keys(fieldsSchema.shape).map((k) => [k, null]),
  ) as Fields;
export const fieldLabels: Record<keyof Fields, string> = {
  name: "名稱",
  speciesId: "全國圖鑑／物種",
  form: "形態",
  cp: "CP",
  hp: "HP",
  gender: "性別",
  height: "身高（m）",
  weight: "體重（kg）",
  shadow: "暗影",
  purified: "淨化",
  shiny: "色違",
  costume: "服裝",
  favorite: "遊戲內最愛",
  ivAtk: "攻擊 IV",
  ivDef: "防禦 IV",
  ivSta: "HP IV",
  fastMove: "一般招式",
  chargeMove: "特殊招式",
  chargeMove2: "第二特殊招式",
  candy: "糖果持有",
  xlCandy: "XL 糖持有",
  stardust: "星塵持有",
  powerUpDust: "單次強化星塵",
  powerUpCandy: "單次強化糖果",
};
// Stored records are typed from the same schemas that validate backups, so a
// new field cannot be silently dropped on restore.
export const validFrame = (frame: string) =>
  /^[a-zA-Z0-9-]{1,80}\/[a-zA-Z0-9_-]{1,140}\.jpg$/.test(frame);
export const frameSchema = z.string().refine(validFrame);
export const ivMeasuredSchema = z.array(z.number().int().min(0).max(15)).length(3).nullable();
/** true: unregistered silhouette; false: coloured icon; unavailable: no button; unknown-branch: uncertain destination. */
export const evolutionSilhouetteSchema = z
  .union([z.boolean(), z.literal("unavailable"), z.literal("unknown-branch")])
  .nullable();
/** Badge on the iPhone detail page; null means that it was not readable. */
export const maxStatusSchema = z.enum(["none", "dynamax", "gigantamax"]).nullable();
const evidenceSchema = z.object({
  observationId: z.string().max(100),
  frame: frameSchema,
  fields: z.array(
    z.enum(Object.keys(fieldsSchema.shape) as [keyof Fields, ...(keyof Fields)[]]),
  ),
  capturedAt: z.string().datetime(),
  scanItemId: z.string().max(100),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const observationSchema = z.object({
  id: z.string().max(100),
  jobId: z.string().max(100),
  frame: frameSchema,
  fields: fieldsSchema,
  issues: z.array(z.string().max(500)),
  ivMeasured: ivMeasuredSchema,
  capturedAt: z.string().datetime(),
  scanItemId: z.string().max(100),
});
export type Observation = z.infer<typeof observationSchema>;
export const pokemonSchema = z.object({
  id: z.string().min(1).max(100),
  jobId: z.string().max(100),
  fields: fieldsSchema,
  overrides: fieldsSchema.partial(),
  sources: z.array(evidenceSchema).max(10000),
  issues: z.array(z.string().max(500)).max(1000),
  candidates: z.array(z.string().max(100)).max(1000),
  verified: z.boolean(),
  verification: z.enum(["human", "automatic"]).nullable(),
  evolutionSilhouette: evolutionSilhouetteSchema,
  maxStatus: maxStatusSchema,
  locked: z.boolean(),
  owned: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // Not validated: importing a backup discards the analysis and evaluates again.
  analysis: z.custom<Analysis | null>(),
});
export type Pokemon = z.infer<typeof pokemonSchema>;
export type Cost = {
  dust: number;
  candy: number;
  xl: number;
  approximate: boolean;
};
export type LeagueResult = {
  league: number;
  speciesId: string;
  name: string;
  metaRank: number | null;
  ivRank: number;
  percentile: number;
  level: number;
  cp: number;
  cost: Cost | null;
  moves: string[];
  elite: string[];
  eligible: boolean;
  buddyCp: number;
};
export type RaidResult = {
  speciesId: string;
  name: string;
  type: string;
  rank: number;
  dps: number;
  fast: string;
  charge: string;
  elite: string[];
  targets: { level: number; cp: number; dps: number; cost: Cost | null }[];
  condition: string | null;
};
export type MoveTrainingTm = "fast" | "charged" | "eliteFast" | "eliteCharged";
export const moveTrainingTmLabels: Record<MoveTrainingTm, string> = {
  fast: "招式學習器（一般）",
  charged: "招式學習器（特殊）",
  eliteFast: "厲害招式學習器（一般）",
  eliteCharged: "厲害招式學習器（特殊）",
};
export type MoveTrainingStep = {
  tm: MoveTrainingTm;
  /** Move to replace; null means the newly unlocked second charged move. */
  from: string | null;
  to: string;
  /** Equally likely outcomes of one use; 1 means the target move is certain. */
  odds: number;
  blocked: boolean;
  note: string | null;
};
export type MoveTrainingAdvice = {
  purpose: "raid" | "pvp";
  label: string;
  /** Raid type rank or PvPoke league rank of the target species. */
  rank: number;
  speciesId: string;
  name: string;
  status: "ready" | "train" | "evolveFirst" | "incomplete";
  steps: MoveTrainingStep[];
  /** Lv.35 cycle DPS with the current and the recommended raid moves. */
  dps: { current: number; best: number } | null;
};
export type Analysis = {
  category: "transfer" | "collect" | "invest" | "evolve" | "review";
  reasons: string[];
  warnings: string[];
  collectionKeys: { key: string; label: string }[];
  leagues: LeagueResult[];
  raids: RaidResult[];
  currentLevels: number[];
  actions: string[];
  evolutionCandy: {
    available: number | null;
    options: {
      speciesId: string;
      name: string;
      required: number;
      condition: string | null;
    }[];
  } | null;
  purification: {
    iv: number[];
    cp: number | null;
    verdict: string;
    /** Missing when the Game Master lists no cost. */
    cost?: { dust: number; candy: number };
  } | null;
  moveTraining: MoveTrainingAdvice[];
  /** PvP and raid slots this Pokémon won, the pool teams are built from. */
  battleSlots: { leagues: LeagueResult[]; raids: RaidResult[] };
  comparedWith: string[];
  snapshot: string | null;
  evaluatedAt: string;
};
export const speciesSchema = z.object({
  id: z.string(),
  dex: z.number().int().min(1),
  name: z.string(),
  /** True when the species is always genderless. */
  genderless: z.boolean(),
  /** Genders this species can have; missing when the Game Master gives none. */
  genders: z.array(z.enum(["male", "female", "genderless"])).optional(),
  types: z.array(z.string()),
  atk: z.number().positive(),
  def: z.number().positive(),
  sta: z.number().positive(),
  fast: z.array(z.string()),
  charged: z.array(z.string()),
  elite: z.array(z.string()),
  tags: z.array(z.string()),
  evolutions: z.array(
    z.object({
      id: z.string(),
      candy: z.number().nonnegative(),
      /** Candy a purified Pokémon pays; missing when the Game Master lists none. */
      candyPurified: z.number().nonnegative().optional(),
      condition: z.string().nullable(),
      gender: z.string().optional(),
    }),
  ),
  /** True when the species can Mega Evolve or undergo Primal Reversion. */
  mega: z.boolean(),
  /** Max forms this species can have; missing when the Game Master has no Max data. */
  maxForms: z.array(z.enum(["dynamax", "gigantamax"])).optional(),
  thirdMove: z.object({ dust: z.number(), candy: z.number() }).nullable(),
  /** Cost to purify the shadow form; missing when the Game Master lists none. */
  purification: z.object({ dust: z.number(), candy: z.number() }).optional(),
  form: z.string().nullable(),
});
export type Species = z.infer<typeof speciesSchema>;
/** An appearance-only form; `label` is the Traditional Chinese text stored in Fields.form. */
const visualFormSchema = z.object({ id: z.string(), label: z.string() });
export type VisualForm = z.infer<typeof visualFormSchema>;
const moveSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  power: z.number().nonnegative(),
  energy: z.number(),
  duration: z.number().positive(),
});
export type Move = z.infer<typeof moveSchema>;
/** The game-data snapshot; backups validate against this same schema. */
export const snapshotSchema = z.object({
  version: z.string().max(100),
  updatedAt: z.string(),
  sourceDate: z.string(),
  sources: z.array(
    z.object({ name: z.string(), url: z.string().url(), version: z.string() }),
  ),
  species: z.record(z.string(), speciesSchema),
  moves: z.record(z.string(), moveSchema),
  rankings: z.record(
    z.string(),
    z.array(
      z.object({
        speciesId: z.string(),
        score: z.number(),
        moves: z.array(z.string()),
      }),
    ),
  ),
  cpm: z.array(z.number().positive()).min(51),
  powerups: z.object({
    dust: z.array(z.number().nonnegative()).min(49),
    candy: z.array(z.number().nonnegative()).min(49),
    xl: z.array(z.number().nonnegative()).min(10),
  }),
  names: z.record(z.string(), z.string()),
  moveNames: z.record(z.string(), z.string()),
  /** Appearance-only forms by dex. */
  visualForms: z.record(z.string(), z.array(visualFormSchema)),
  warnings: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const settingsSchema = z.object({
  raidSlots: z.number().int().min(1).max(24),
  metaCutoff: z.number().int().min(1).max(300),
  ivCutoff: z.number().int().min(1).max(4096),
  rareRepresentatives: z.number().int().min(1).max(10),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  raidSlots: 6,
  metaCutoff: 100,
  ivCutoff: 100,
  rareRepresentatives: 1,
};
export const categoryLabels = {
  transfer: "可放生",
  collect: "保留收藏",
  invest: "值得培養",
  evolve: "可進化",
  review: "待確認",
};
export const effective = (p: Pokemon): Fields => {
  const f = { ...p.fields, ...p.overrides };
  // A costume-only species ID already says which costume the Pokémon wears.
  return f.costume === null ? { ...f, costume: speciesCostume(f.speciesId) } : f;
};
/**
 * The Max status, or none when it cannot be anything else: the species has no
 * Max form, or the Pokémon is shadow or purified, which Max Battles never give.
 */
export function knownMaxStatus(p: Pokemon, species: Species | null | undefined): MaxStatus | null {
  if (p.maxStatus != null) return p.maxStatus;
  const f = effective(p);
  return f.shadow === true || f.purified === true || species?.maxForms?.length === 0 ? "none" : null;
}
