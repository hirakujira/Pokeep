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
  // No longer scanned or used because the Game Master gives these costs; kept
  // so stored records and older backups still parse.
  evolutionCandy: numberOrNull,
  secondMoveDust: numberOrNull,
  secondMoveCandy: numberOrNull,
  purificationDust: numberOrNull,
  purificationCandy: numberOrNull,
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
  evolutionCandy: "進化糖果",
  secondMoveDust: "開招星塵",
  secondMoveCandy: "開招糖果",
  purificationDust: "淨化星塵",
  purificationCandy: "淨化糖果",
};
export type Evidence = {
  observationId: string;
  frame: string;
  time: number;
  video: string;
  fields: (keyof Fields)[];
  source?: "video" | "iphone";
  capturedAt?: string;
  scanItemId?: string;
};
export type Observation = {
  id: string;
  jobId: string;
  segment: string;
  frame: string;
  time: number;
  video: string;
  fields: Fields;
  issues: string[];
  ivMeasured: number[] | null;
  kind: string;
  source?: "video" | "iphone";
  capturedAt?: string;
  scanItemId?: string;
};
export type Pokemon = {
  id: string;
  jobId: string;
  fields: Fields;
  overrides: Partial<Fields>;
  sources: Evidence[];
  issues: string[];
  candidates: string[];
  verified: boolean;
  verification?: "human" | "automatic" | null;
  /** true: unregistered silhouette; false: coloured icon; unavailable: no button; unknown-branch: uncertain destination. */
  evolutionSilhouette?: boolean | "unavailable" | "unknown-branch" | null;
  /** Badge on the iPhone detail page; null means that it was not readable. */
  maxStatus?: MaxStatus | null;
  locked: boolean;
  owned: boolean;
  createdAt: string;
  updatedAt: string;
  analysis: Analysis | null;
};
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
  evolutionCandy?: {
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
    /** Missing when the Game Master lists no cost or the analysis predates it. */
    cost?: { dust: number; candy: number };
  } | null;
  /** Absent in analyses saved before move training advice existed. */
  moveTraining?: MoveTrainingAdvice[];
  comparedWith: string[];
  snapshot: string | null;
  evaluatedAt: string;
};
export type JobStatus =
  "queued" | "processing" | "review" | "completed" | "failed" | "cancelled";
export type VideoFile = {
  id: string;
  name: string;
  path: string;
  size: number;
  duration: number;
  width: number;
  height: number;
};
export type Job = {
  id: string;
  name: string;
  status: JobStatus;
  stage: string;
  progress: number;
  files: VideoFile[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  usage: { input: number; output: number; requests: number; cached: number };
  notices: string[];
  attempts: number;
};
export type Species = {
  id: string;
  dex: number;
  name: string;
  /** True when the species is always genderless. */
  genderless?: boolean;
  /** Genders this species can have; missing when the Game Master gives none. */
  genders?: Gender[];
  types: string[];
  atk: number;
  def: number;
  sta: number;
  fast: string[];
  charged: string[];
  elite: string[];
  tags: string[];
  evolutions: {
    id: string;
    candy: number;
    /** Candy a purified Pokémon pays; missing when the Game Master lists none. */
    candyPurified?: number;
    condition: string | null;
    gender?: string;
  }[];
  /** True when the species can Mega Evolve or undergo Primal Reversion. */
  mega?: boolean;
  /** Max forms this species can have; missing when the snapshot predates the Max data. */
  maxForms?: ("dynamax" | "gigantamax")[];
  thirdMove: { dust: number; candy: number } | null;
  /** Cost to purify the shadow form; missing when the Game Master lists none or the snapshot predates it. */
  purification?: { dust: number; candy: number };
  form: string | null;
};
/** An appearance-only form; `label` is the Traditional Chinese text stored in Fields.form. */
export type VisualForm = { id: string; label: string };
export type Move = {
  id: string;
  name: string;
  type: string;
  power: number;
  energy: number;
  duration: number;
};
export type Snapshot = {
  version: string;
  updatedAt: string;
  sourceDate: string;
  sources: { name: string; url: string; version: string }[];
  species: Record<string, Species>;
  moves: Record<string, Move>;
  rankings: Record<
    string,
    { speciesId: string; score: number; moves: string[] }[]
  >;
  cpm: number[];
  powerups: { dust: number[]; candy: number[]; xl: number[] };
  names: Record<string, string>;
  moveNames: Record<string, string>;
  /** Appearance-only forms by dex; absent in snapshots saved before forms were collected. */
  visualForms?: Record<string, VisualForm[]>;
  warnings: string[];
};
export type Settings = {
  raidSlots: number;
  metaCutoff: number;
  ivCutoff: number;
  rareRepresentatives: number;
};
export const settingsSchema = z.object({
  raidSlots: z.number().int().min(1).max(24),
  metaCutoff: z.number().int().min(1).max(300),
  ivCutoff: z.number().int().min(1).max(4096),
  rareRepresentatives: z.number().int().min(1).max(10),
});
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
