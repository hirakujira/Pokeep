import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { measureIV, type IvMeasurement } from "../iv";
import { recognizeScanWithOcr, type OcrVisionResult } from "../ocr-vision";
import { inferLevels } from "../evaluate";
import { matching } from "../matching";
import {
  dataDir,
  get,
  getSnapshot,
  id,
  listPokemon,
  now,
  put,
  transaction,
} from "../store";
import { updateScan } from "../iphone-data";
import {
  effective,
  emptyFields,
  type Fields,
  type Observation,
  type Pokemon,
  type Snapshot,
} from "../types";
import type { Scan, ScanItem } from "../iphone-types";
import {
  automaticVerification,
  blockingEvidenceIssues,
  reconcilePageIssues,
  speciesGender,
  specialStateFromMoves,
  requireSpecialCorroboration,
} from "../iphone-safety";
import { applySpecialVisualVerdict } from "../special-visual-review";
import { displayForm, uniqueFormFromStats } from "../iphone-form";

type ScreenResult = OcrVisionResult["top"];
type ShinyReview = NonNullable<ScanItem["shinyReview"]>;
type SpecialReview = NonNullable<ScanItem["specialReview"]>;
type MoveState = ReturnType<typeof specialStateFromMoves>;

export function mergeScreens(
  results: { fields: Fields; issues: string[]; clear: boolean }[],
) {
  const fields = emptyFields();
  const issues = results.flatMap((row) => row.issues);
  for (const row of results)
    for (const key of Object.keys(fields) as (keyof Fields)[]) {
      const value = row.fields[key];
      if (value === null) continue;
      if (fields[key] !== null && fields[key] !== value)
        issues.push(`多個畫面欄位衝突：${key}`);
      else (fields as Record<string, unknown>)[key] = value;
    }
  return {
    fields,
    issues: [...new Set(issues)],
    clear: results.every((row) => row.clear),
  };
}

export type PreparedAnalysis = {
  recognized: OcrVisionResult;
  measuredAgain: IvMeasurement | null;
};

export function recordAnalysisUsage(
  scanId: string,
  tokens: { input: number; output: number; cached: boolean },
) {
  const current = get<Scan>("scans", scanId)!;
  updateScan(scanId, {
    apiUsage: {
      input: current.apiUsage.input + tokens.input,
      output: current.apiUsage.output + tokens.output,
      requests: current.apiUsage.requests + Number(!tokens.cached),
      cached: current.apiUsage.cached + Number(tokens.cached),
      dataRequests:
        (current.apiUsage.dataRequests || 0) + Number(!tokens.cached),
      navigationRequests: current.apiUsage.navigationRequests || 0,
    },
  });
}

export async function prepareAnalysis(
  scanId: string,
  item: ScanItem,
  signal: AbortSignal,
): Promise<PreparedAnalysis> {
  if (!item.movesFrame || !item.appraisalFrame)
    throw new Error(`第 ${item.position + 1} 隻缺少完整截圖，已暫停解析`);
  const snapshot = getSnapshot();
  const [recognized, measuredAgain] = await Promise.all([
    recognizeScanWithOcr(
      [item.frame, item.movesFrame, item.appraisalFrame],
      snapshot,
      signal,
      (usage) => recordAnalysisUsage(scanId, usage),
    ),
    measureIV(path.join(dataDir, "frames", item.appraisalFrame)),
  ]);
  return { recognized, measuredAgain };
}

function measuredAppraisal(
  item: ScanItem,
  recognized: OcrVisionResult,
  measuredAgain: IvMeasurement | null,
) {
  const ivStable =
    !!item.measuredIV &&
    item.measuredIV.length === 3 &&
    !!measuredAgain &&
    measuredAgain.confidence >= 0.8 &&
    measuredAgain.values.every((value, index) => value === item.measuredIV![index]);
  const appraisalResult = {
    ...recognized.appraisal,
    fields: {
      ...recognized.appraisal.fields,
      ivAtk: ivStable ? item.measuredIV![0] : null,
      ivDef: ivStable ? item.measuredIV![1] : null,
      ivSta: ivStable ? item.measuredIV![2] : null,
    },
  };
  return { ivStable, appraisalResult };
}

function applyMoveState(fields: Fields, issues: string[], snapshot: Snapshot | null) {
  const moveState = specialStateFromMoves(fields);
  if (moveState.conflict)
    issues.push("招式與暗影／淨化狀態衝突，請人工核對");
  else {
    fields.shadow = moveState.shadow;
    fields.purified = moveState.purified;
    if (fields.speciesId && moveState.signal && snapshot) {
      const base = fields.speciesId.replace(/_shadow$/, "");
      const wanted = moveState.signal === "frustration" ? `${base}_shadow` : base;
      if (snapshot.species[wanted]) fields.speciesId = wanted;
      else issues.push("招式與物種形態無法對應，請人工核對");
    }
  }
  return moveState;
}

function pushScreenIssues(
  issues: string[],
  visual: OcrVisionResult["visual"],
  ivStable: boolean,
  genderConflict: boolean,
  top: Fields,
  appraisal: Fields,
) {
  if (genderConflict)
    issues.push("畫面性別辨識與物種無性別資料衝突，請人工核對");
  if (!ivStable)
    issues.push("本機 IV 條量測不穩定或與截圖檢查點不一致，請人工核對");
  if (!visual.detailClear)
    issues.push("截圖未能確認為能力頁，請人工核對");
  if (visual.hasUnexpectedOverlay || visual.warningVisible)
    issues.push("截圖出現遮擋或警告，請人工核對");
  if (
    top.cp !== null &&
    appraisal.cp !== null &&
    top.cp !== appraisal.cp
  )
    issues.push("能力與評價頁 CP 不一致");
  if (
    top.name &&
    appraisal.name &&
    top.name !== appraisal.name
  )
    issues.push("能力與評價頁名稱不一致");
}

type Interpretation = {
  topResult: ScreenResult;
  lowerResult: ScreenResult;
  appraisalResult: ScreenResult;
  fields: Fields;
  issues: string[];
  protectionClear: boolean;
  moveState: MoveState;
  complete: boolean;
};

function interpretScreens(
  item: ScanItem,
  { recognized, measuredAgain }: PreparedAnalysis,
  snapshot: Snapshot | null,
  shinyReview?: ShinyReview,
  specialReview?: SpecialReview,
): Interpretation {
  const { top: topResult, moves: lowerResult } = recognized;
  const { ivStable, appraisalResult } =
    measuredAppraisal(item, recognized, measuredAgain);
  const protectionClear =
    recognized.visual.detailClear &&
    !recognized.visual.hasUnexpectedOverlay &&
    recognized.visual.costumeAbsentClear &&
    !recognized.visual.warningVisible;
  const merged = mergeScreens([
    topResult,
    lowerResult,
    appraisalResult,
  ]);
  const fields = merged.fields;
  requireSpecialCorroboration(fields, snapshot);
  if (item.pokemonId && specialReview)
    applySpecialVisualVerdict(fields, specialReview.verdict, snapshot);
  const moveState = applyMoveState(fields, merged.issues, snapshot);
  if (
    snapshot &&
    ivStable &&
    protectionClear &&
    merged.issues.length === 0 &&
    topResult.fields.name &&
    topResult.fields.name === appraisalResult.fields.name &&
    topResult.fields.cp === appraisalResult.fields.cp
  ) {
    const corrected = uniqueFormFromStats(fields, snapshot);
    if (corrected) {
      fields.speciesId = corrected.species.id;
      fields.form = displayForm(corrected.species);
    }
  }
  const species = fields.speciesId ? snapshot?.species[fields.speciesId] : undefined;
  const gender = speciesGender(fields.gender, species || null);
  fields.gender = gender.gender;
  if (item.pokemonId && shinyReview?.verdict === "normal" && fields.shiny === null)
    fields.shiny = false;
  if (item.pokemonId && shinyReview?.verdict === "shiny" && fields.shiny === null)
    fields.shiny = true;
  pushScreenIssues(
    merged.issues,
    recognized.visual,
    ivStable,
    gender.conflict,
    topResult.fields,
    appraisalResult.fields,
  );
  const levels =
    species && snapshot ? inferLevels(species, fields, snapshot) : [];
  merged.issues = reconcilePageIssues({
    issues: merged.issues,
    fields,
    top: topResult.fields,
    appraisal: appraisalResult.fields,
    speciesName: species?.name,
    detailClear: recognized.visual.detailClear,
    costumeAbsentClear: protectionClear,
  });
  const complete = automaticVerification({
    fields,
    top: topResult.fields,
    appraisal: appraisalResult.fields,
    measuredIV: item.measuredIV || null,
    levels,
    clear: merged.clear,
    issues: blockingEvidenceIssues(merged.issues, fields),
    costumeAbsentClear: protectionClear,
    warningVisible: recognized.visual.warningVisible,
  });
  return {
    topResult,
    lowerResult,
    appraisalResult,
    fields,
    issues: merged.issues,
    protectionClear,
    moveState,
    complete,
  };
}

function inferredFields(
  existing: Pokemon | null,
  fields: Fields,
  moveState: MoveState,
  shinyReview?: ShinyReview,
  specialReview?: SpecialReview,
) {
  const gender =
    existing?.fields.gender === null && fields.gender === "genderless";
  const shiny =
    existing?.fields.shiny === null &&
    fields.shiny !== null &&
    shinyReview?.verdict === (fields.shiny ? "shiny" : "normal");
  const shadow =
    existing?.fields.shadow === null &&
    fields.shadow !== null &&
    (moveState.signal !== null || specialReview?.verdict === "normal" || specialReview?.verdict === "shadow" || specialReview?.verdict === "purified") &&
    !moveState.conflict;
  const purified =
    existing?.fields.purified === null &&
    fields.purified !== null &&
    (moveState.signal !== null || specialReview?.verdict === "shadow" || specialReview?.verdict === "purified") &&
    !moveState.conflict;
  const species =
    Boolean(
      existing &&
        (moveState.signal || specialReview?.verdict === "shadow") &&
        !moveState.conflict &&
        existing.fields.speciesId !== fields.speciesId &&
        existing.fields.speciesId?.replace(/_shadow$/, "") ===
          fields.speciesId?.replace(/_shadow$/, ""),
    );
  return { gender, shiny, shadow, purified, species };
}

function recheckExistingRecord(
  scanId: string,
  item: ScanItem,
  { fields, moveState, complete }: Interpretation,
  shinyReview?: ShinyReview,
  specialReview?: SpecialReview,
) {
  const existing = get<Pokemon>("pokemon", item.pokemonId!);
  const inferred = inferredFields(existing, fields, moveState, shinyReview, specialReview);
  const anyInferred = inferred.gender || inferred.shiny || inferred.shadow ||
    inferred.purified || inferred.species;
  if (
    existing &&
    existing.jobId === scanId &&
    !existing.verified &&
    existing.verification !== "human" &&
    existing.candidates.length === 0 &&
    Object.keys(existing.overrides).length === 0 &&
    isDeepStrictEqual(
      existing.fields,
      {
        ...fields,
        gender: inferred.gender ? null : fields.gender,
        shiny: inferred.shiny ? null : fields.shiny,
        shadow: inferred.shadow ? null : fields.shadow,
        purified: inferred.purified ? null : fields.purified,
        speciesId: inferred.species ? existing.fields.speciesId : fields.speciesId,
      },
    ) &&
    (anyInferred || (existing.fields.favorite === true && complete))
  )
    transaction(() => {
      const current = get<Scan>("scans", scanId)!;
      if (current.status !== "running" && current.status !== "completed")
        return;
      const verified =
        complete && blockingEvidenceIssues(existing.issues, fields).length === 0;
      put("pokemon", existing.id, {
        ...existing,
        fields: anyInferred ? fields : existing.fields,
        verified,
        verification: verified ? "automatic" : null,
        updatedAt: now(),
      });
      if (anyInferred)
        put("scan_items", item.id, {
          ...item,
          fields,
          shinyReview: shinyReview || item.shinyReview,
          specialReview: specialReview || item.specialReview,
        });
      if (verified)
        updateScan(scanId, { review: Math.max(0, current.review - 1) });
    });
}

function scanObservations(
  scanId: string,
  item: ScanItem,
  frames: string[],
  screens: Fields[],
  issues: string[],
): Observation[] {
  return frames.map((frame, index) => ({
    id: `${scanId}-${item.position}-${index}`,
    jobId: scanId,
    frame,
    fields: screens[index],
    issues: index === 2 ? issues : [],
    ivMeasured: index === 2 ? item.measuredIV || null : null,
    capturedAt: item.capturedAt,
    scanItemId: item.id,
  }));
}

function saveNewRecord(
  scanId: string,
  item: ScanItem,
  frames: string[],
  visual: OcrVisionResult["visual"],
  { topResult, lowerResult, appraisalResult, fields, issues, protectionClear, complete }: Interpretation,
) {
  const evolutionSilhouette = visual.evolutionSilhouette;
  const maxStatus = visual.maxStatus;
  const observations = scanObservations(
    scanId,
    item,
    frames,
    [topResult.fields, lowerResult.fields, appraisalResult.fields],
    issues,
  );
  const prior = listPokemon().filter(
    (p) => p.owned && matching(effective(p), fields) !== "different",
  );
  const recordIssues = prior.length
    ? [...issues, "疑似與既有個體重複，請人工核對"]
    : issues;
  const pokemon: Pokemon = {
    id: id(),
    jobId: scanId,
    fields,
    overrides: {},
    sources: observations.map((o) => ({
      observationId: o.id,
      frame: o.frame,
      fields: (Object.keys(o.fields) as (keyof Fields)[]).filter(
        (key) => o.fields[key] !== null,
      ),
      capturedAt: item.capturedAt,
      scanItemId: item.id,
    })),
    issues: recordIssues,
    candidates: prior.map((p) => p.id),
    verified: complete && !prior.length,
    verification: complete && !prior.length ? "automatic" : null,
    evolutionSilhouette,
    maxStatus,
    locked: false,
    owned: true,
    createdAt: item.capturedAt,
    updatedAt: now(),
    analysis: null,
  };
  transaction(() => {
    const current = get<Scan>("scans", scanId)!;
    if (current.status !== "running") return;
    for (const observation of observations)
      put("observations", observation.id, observation);
    put("pokemon", pokemon.id, pokemon);
    put("scan_items", item.id, {
      ...item,
      pokemonId: pokemon.id,
      fields,
      issues: recordIssues,
      protectionClear,
      evolutionSilhouette,
      maxStatus,
      favoriteRechecked: true,
      analyzedAt: now(),
    });
    updateScan(scanId, {
      analyzed: (current.analyzed || 0) + 1,
      review: current.review + Number(!pokemon.verified),
      stage: current.phase === "analysis"
        ? `已解析 ${(current.analyzed || 0) + 1} / ${current.scanned} 隻`
        : `已截圖 ${current.scanned} 隻；同步解析 ${(current.analyzed || 0) + 1} 隻`,
    });
  });
}

export async function analyzeOne(
  scanId: string,
  item: ScanItem,
  prepared?: Promise<PreparedAnalysis>,
  recheckExisting = false,
  shinyReview?: ShinyReview,
  specialReview?: SpecialReview,
) {
  if (item.pokemonId && !recheckExisting) return;
  if (!item.movesFrame || !item.appraisalFrame)
    throw new Error(`第 ${item.position + 1} 隻缺少完整截圖，已暫停解析`);
  const analysis =
    await (prepared || prepareAnalysis(scanId, item, new AbortController().signal));
  const snapshot = getSnapshot();
  const result = interpretScreens(item, analysis, snapshot, shinyReview, specialReview);
  if (item.pokemonId) {
    recheckExistingRecord(scanId, item, result, shinyReview, specialReview);
    return;
  }
  saveNewRecord(
    scanId,
    item,
    [item.frame, item.movesFrame, item.appraisalFrame],
    analysis.recognized.visual,
    result,
  );
}
