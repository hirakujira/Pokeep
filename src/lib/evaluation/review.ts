import {
  effective,
  type Analysis,
  type Fields,
  type Observation,
  type Pokemon,
} from "../types";
import { get } from "../store";
import { blockingEvidenceIssues, specialStateFromMoves } from "../iphone-safety";
import type { ScanItem } from "../iphone-types";

export function verificationEvidenceGaps(
  item: ScanItem | null,
  top: Observation | null,
  appraisal: Observation | null,
  levels: number[],
  issues: string[] = [],
  costume: string | null = null,
) {
  if (!item) return ["沒有保存可供自動核對的手機掃描檢查點"];
  const gaps: string[] = [];
  // Other failed visual checks add a saved issue during analysis. Without one,
  // the remaining failed protection check is costumeAbsentClear.
  if (!item.protectionClear)
    gaps.push(costume
      ? `已辨識特殊服裝（${costume}），造型需人工核對`
      : issues.length
        ? "能力頁外觀安全檢查未通過；請查看下方截圖問題"
        : "外觀辨識未能確認沒有特殊服裝");
  if (!top || !appraisal) {
    gaps.push("缺少能力頁或評價頁的辨識紀錄");
  } else {
    if (!top.fields.name || !appraisal.fields.name)
      gaps.push(`${!top.fields.name ? "能力頁" : "評價頁"}名稱辨識結果為空，無法交叉比對`);
    else if (top.fields.name !== appraisal.fields.name)
      gaps.push("能力頁與評價頁名稱不一致");
    if (top.fields.cp === null || appraisal.fields.cp === null)
      gaps.push(`${top.fields.cp === null ? "能力頁" : "評價頁"} CP 辨識結果為空，無法交叉比對`);
    else if (top.fields.cp !== appraisal.fields.cp)
      gaps.push("能力頁與評價頁 CP 不一致");
    const iv = [appraisal.fields.ivAtk, appraisal.fields.ivDef, appraisal.fields.ivSta];
    if (!item.measuredIV || item.measuredIV.length !== 3 ||
        iv.some((value, index) => value === null || value !== item.measuredIV![index]))
      gaps.push("評價頁 IV 與本機量測未一致");
  }
  if (levels.length > 1) gaps.push("CP、HP 與 IV 對應多個可能等級");
  return gaps;
}

function unverifiedReason(p: Pokemon, a: Analysis) {
  const source = p.sources[0];
  const item = source ? get<ScanItem>("scan_items", source.scanItemId) : null;
  const observation = (frame: string | null | undefined) => {
    const evidence = p.sources.find((entry) => entry.frame === frame &&
      entry.scanItemId === source?.scanItemId);
    return evidence ? get<Observation>("observations", evidence.observationId) : null;
  };
  const gaps = verificationEvidenceGaps(
    item,
    observation(item?.frame),
    observation(item?.appraisalFrame),
    a.currentLevels,
    p.issues,
    effective(p).costume,
  );
  return gaps.length
    ? `自動核對未通過：${gaps.join("；")}`
    : "當時未保存自動核對失敗的細項；請對照來源截圖人工核對";
}

export function reviewReason(p: Pokemon, f: Fields, a: Analysis) {
  if (p.candidates.length) return "與既有個體配對不明，請核對是否為同一隻";
  if (specialStateFromMoves(f).conflict)
    return "招式與暗影／淨化狀態衝突，請人工核對";
  const evidenceIssue = blockingEvidenceIssues(p.issues, f)[0];
  if (evidenceIssue) return evidenceIssue;
  if (!f.speciesId) return "物種或形態尚未確認";
  if (f.cp === null || [f.ivAtk, f.ivDef, f.ivSta].some((v) => v === null))
    return "CP 或 IV 資料不完整";
  if (f.shiny === null) return "色違狀態無法從截圖確認";
  if (f.shadow === null || f.purified === null)
    return "暗影或淨化狀態尚未確認";
  if (f.favorite === null) return "最愛狀態尚未確認";
  if (f.gender === null) return "性別尚未辨識";
  if (f.hp === null || f.height === null || f.weight === null)
    return "HP、身高或體重資料不完整";
  if (!a.currentLevels.length) return "CP、HP 與 IV 無法對應合理等級";
  if (!p.verified) return unverifiedReason(p, a);
  const analysisGap = a.warnings.find(
    (warning) => warning.includes("不完整") || warning.includes("不適用"),
  );
  if (analysisGap) return `已核對個體；${analysisGap}`;
  return "資料或配對尚待核對，暫不給放生結論";
}
