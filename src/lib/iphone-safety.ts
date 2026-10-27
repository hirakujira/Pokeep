import { createHash } from "node:crypto";
import {
  effective,
  type Fields,
  type Pokemon,
  type Snapshot,
  type Settings,
  type Species,
} from "./types";
import type { TransferBatch } from "./iphone-types";

const identityKeys = [
  "speciesId",
  "form",
  "cp",
  "hp",
  "ivAtk",
  "ivDef",
  "ivSta",
  "gender",
  "height",
  "weight",
  "shadow",
  "purified",
  "shiny",
  "favorite",
] as const;

export function speciesGender(
  observed: Fields["gender"],
  species: Species | null | undefined,
) {
  if (!species?.genderless) return { gender: observed, conflict: false };
  if (observed === null) return { gender: "genderless" as const, conflict: false };
  return { gender: observed, conflict: observed !== "genderless" };
}

/** These moves prove a state when present; their absence proves nothing. */
export function specialStateFromMoves(fields: Fields) {
  const moves = [fields.chargeMove, fields.chargeMove2]
    .filter((move): move is string => Boolean(move))
    .map((move) => move.trim().toUpperCase());
  const frustration = moves.some((move) =>
    ["FRUSTRATION", "遷怒"].includes(move),
  );
  const returned = moves.some((move) => ["RETURN", "報恩"].includes(move));
  if (frustration && returned)
    return {
      shadow: fields.shadow,
      purified: fields.purified,
      signal: null,
      conflict: true,
    } as const;
  if (frustration) {
    const conflict = fields.shadow === false || fields.purified === true;
    return {
      shadow: conflict ? fields.shadow : true,
      purified: conflict ? fields.purified : false,
      signal: "frustration",
      conflict,
    } as const;
  }
  if (returned) {
    const conflict = fields.shadow === true || fields.purified === false;
    return {
      shadow: conflict ? fields.shadow : false,
      purified: conflict ? fields.purified : true,
      signal: "return",
      conflict,
    } as const;
  }
  return {
    shadow: fields.shadow,
    purified: fields.purified,
    signal: null,
    conflict: false,
  } as const;
}

/** A single cropped appearance can confuse a brief purple effect with shadow. */
export function requireSpecialCorroboration(fields: Fields, snapshot: Snapshot | null) {
  if (specialStateFromMoves(fields).signal ||
      (fields.shadow !== true && fields.purified !== true)) return false;
  fields.shadow = null;
  fields.purified = null;
  const base = fields.speciesId?.replace(/_shadow$/, "");
  if (base && snapshot?.species[base]) fields.speciesId = base;
  return true;
}

export function samePhoneIdentity(a: Fields, b: Fields) {
  return identityKeys.every(
    (key) => a[key] !== null && b[key] !== null && a[key] === b[key],
  );
}

/** An appraisal overlay does not hide values already read on the detail pages. */
function coveredResourceOcclusion(issue: string, fields?: Fields | null) {
  if (
    !fields ||
    !/(評價|隊長|徽章)/.test(issue) ||
    !/(遮|擋)/.test(issue) ||
    !/(資源|星塵|糖果|強化|按鈕|成本)/.test(issue) ||
    /(名稱|寶可夢外觀|外觀特徵|CP|HP|IV|個體值|性別|物種|形態|色違|服裝|暗影|淨化|評價條|身高|體重|詳細資訊)/.test(issue)
  )
    return false;
  if (/資源|星塵/.test(issue) && fields.stardust === null) return false;
  if (/資源|糖果/.test(issue) && fields.candy === null) return false;
  if (/XL\s*糖果/.test(issue) && fields.xlCandy === null) return false;
  if (
    /(強化|成本)/.test(issue) &&
    (fields.powerUpDust === null || fields.powerUpCandy === null)
  )
    return false;
  return true;
}

/** A note about one cropped page cannot negate identity visible on the other pages. */
export function reconcilePageIssues(input: {
  issues: string[];
  fields: Fields;
  top: Fields;
  appraisal: Fields;
  speciesName?: string | null;
  detailClear: boolean;
  costumeAbsentClear: boolean;
}) {
  const { top, appraisal } = input;
  const identityCorroborated =
    input.detailClear &&
    Boolean(top.name && top.speciesId && top.name === appraisal.name) &&
    top.cp !== null &&
    top.cp === appraisal.cp &&
    top.hp !== null &&
    (appraisal.hp === null || top.hp === appraisal.hp) &&
    (appraisal.speciesId === null || top.speciesId === appraisal.speciesId);
  return input.issues.filter((issue) => {
    if (coveredResourceOcclusion(issue, input.fields)) return false;
    if (
      identityCorroborated &&
      /^畫面僅顯示詳情頁下半部/.test(issue)
    )
      return false;
    if (
      identityCorroborated &&
      input.costumeAbsentClear &&
      top.name === input.speciesName &&
      appraisal.speciesId === top.speciesId &&
      issue === "物種／形態無法唯一對應，請選擇正確物種"
    )
      return false;
    return true;
  });
}

export function blockingEvidenceIssues(issues: string[], fields?: Fields | null) {
  return issues.filter((issue) => {
    if (
      issue ===
      "畫面上方未顯示名稱、CP及寶可夢完整外觀，無法確認形態與外觀特徵。"
    )
      return false;
    if (coveredResourceOcclusion(issue, fields)) return false;
    return true;
  });
}

export function automaticVerification(input: {
  fields: Fields;
  top: Fields;
  appraisal: Fields;
  measuredIV: number[] | null;
  levels: number[];
  clear: boolean;
  issues: string[];
  costumeAbsentClear: boolean;
  warningVisible: boolean;
}) {
  const { fields: f, top, appraisal, measuredIV, levels } = input;
  if (
    !input.clear ||
    input.issues.length ||
    !input.costumeAbsentClear ||
    input.warningVisible ||
    levels.length !== 1
  )
    return false;
  if (
    !measuredIV ||
    measuredIV.length !== 3 ||
    !(["ivAtk", "ivDef", "ivSta"] as const).every(
      (key, index) =>
        appraisal[key] !== null && appraisal[key] === measuredIV[index],
    )
  )
    return false;
  if (
    !top.name ||
    !appraisal.name ||
    top.name !== appraisal.name ||
    top.cp === null ||
    appraisal.cp === null ||
    top.cp !== appraisal.cp
  )
    return false;
  if (
    !f.speciesId ||
    !f.name ||
    f.cp === null ||
    f.hp === null ||
    f.gender === null ||
    f.height === null ||
    f.weight === null ||
    f.favorite === null ||
    f.shadow === null ||
    f.purified === null ||
    f.shiny === null
  )
    return false;
  return true;
}

export function transferExclusion(
  p: Pokemon,
  snapshot: Snapshot | null,
): string | null {
  const f = effective(p);
  if (specialStateFromMoves(f).conflict)
    return "招式與暗影／淨化狀態衝突，需人工核對";
  const species = f.speciesId ? snapshot?.species[f.speciesId] : null;
  if (
    !p.owned ||
    p.locked ||
    !p.verified ||
    p.candidates.length ||
    (blockingEvidenceIssues(p.issues, f).length > 0 && p.verification !== "human")
  )
    return "未持有、鎖定或核對尚未完成";
  if (
    species?.tags.some((tag) =>
      ["legendary", "mythical", "ultrabeast"].includes(tag),
    )
  ) return "傳說、幻之或究極異獸";
  if (p.analysis?.category !== "transfer") return "目前不屬於可放生建議";
  if (p.evolutionSilhouette === true &&
      !p.analysis.reasons.includes("同類已有更適合進化的個體"))
    return "未登錄進化剪影尚無已保留的進化代表";
  if (p.maxStatus == null) return "極巨化狀態尚未確認";
  if (!species || p.analysis?.currentLevels.length !== 1)
    return "缺少唯一的目前等級或有效遊戲資料";
  if (
    f.favorite === null ||
    f.shiny !== false ||
    f.shadow === null ||
    f.purified === null ||
    f.costume !== null
  )
    return "最愛狀態不明或特殊狀態未能安全排除";
  if (
    [f.cp, f.hp, f.gender, f.height, f.weight, f.ivAtk, f.ivDef, f.ivSta].some(
      (v) => v === null,
    )
  )
    return "個體身分資料不完整";
  if (
    [f.ivAtk, f.ivDef, f.ivSta].every((v) => v === 15) ||
    [f.ivAtk, f.ivDef, f.ivSta].every((v) => v === 0)
  )
    return "滿 IV 或零 IV";
  return null;
}

export function transferSignature(
  batch: Pick<TransferBatch, "scanId" | "entries" | "searchExclusions">,
  records: Pokemon[],
  snapshot: Snapshot | null,
  settings: Settings,
) {
  const selected = batch.entries.map(
    (entry) => records.find((p) => p.id === entry.pokemonId) || null,
  );
  // Collection analysis depends on all owned peers, not only transfer candidates.
  const peers = records.map((p) => ({
    id: p.id,
    owned: p.owned,
    verified: p.verified,
    locked: p.locked,
    maxStatus: p.maxStatus ?? null,
    fields: effective(p),
    analysis: p.analysis?.category,
    candidates: p.candidates,
  }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        scanId: batch.scanId,
        ...(batch.searchExclusions && { searchExclusions: batch.searchExclusions }),
        selected,
        peers,
        snapshot: snapshot?.version,
        settings,
      }),
    )
    .digest("hex");
}

export function hasUncertainOperation(batch: TransferBatch) {
  return batch.entries.some((entry) =>
    ["searching", "unfavoriting", "prepared", "sent", "uncertain"].includes(entry.status),
  );
}
