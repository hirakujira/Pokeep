import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { IphoneMcp, iphoneUseVersion } from "./iphone-mcp";
import {
  inspectPhoneImage,
  phoneVisionBottom,
  type PhonePage,
  type Target,
} from "./iphone-vision";
import { saveEvidenceFrame } from "./frame-evidence";
import { measureIV, type IvMeasurement } from "./iv";
import { detailFingerprint } from "./iphone-fingerprint";
import { recognizeScanWithOcr, type OcrVisionResult } from "./ocr-vision";
import { inferLevels, reevaluate } from "./evaluate";
import { matching } from "./matching";
import {
  dataDir,
  get,
  getSnapshot,
  id,
  listPokemon,
  now,
  put,
  transaction,
} from "./store";
import { scanItems, updateScan } from "./iphone-data";
import {
  effective,
  emptyFields,
  type Fields,
  type Observation,
  type Pokemon,
} from "./types";
import type { Scan, ScanItem } from "./iphone-types";
import {
  automaticVerification,
  blockingEvidenceIssues,
  reconcilePageIssues,
  speciesGender,
  specialStateFromMoves,
} from "./iphone-safety";
import { processPreparedInOrder } from "./ordered-prefetch";
import { reviewShiny } from "./shiny-review";
import { displayForm, uniqueFormFromStats } from "./iphone-form";

type PhoneObservation = {
  app: string;
  observation_id: string;
  image?: {
    path: string;
    width: number;
    height: number;
    pixel_to_point: number[];
  };
  viewport: { width: number; height: number };
};

const pageCache = new Map<string, PhonePage>();
async function inspectObservation(
  observation: PhoneObservation,
  target: Target | null = null,
  redactLocation = false,
) {
  if (!observation.image?.path) throw new Error("手機沒有回傳截圖");
  const key = `${observation.observation_id}:${observation.image.path}:${target || "page"}:${redactLocation}`;
  const cached = pageCache.get(key);
  if (cached) return cached;
  const page = await inspectPhoneImage(
    observation.image.path,
    target,
    redactLocation,
  );
  if (pageCache.size >= 64) pageCache.delete(pageCache.keys().next().value!);
  pageCache.set(key, page);
  return page;
}

export async function ensureReady(phone: IphoneMcp) {
  type Setup = {
    ok?: boolean;
    error?: string;
    configured?: boolean;
    service?: { ready?: boolean; reachable?: boolean };
    jobs?: {
      id: string;
      action?: string;
      state?: string;
      error?: string;
      next_steps?: string[];
    }[];
    job_id?: string;
  };
  const status = await phone.call<Setup>("setup", { action: "status" });
  if (status.ok === false)
    throw new Error(status.error || "iPhone Use 設定檢查失敗");
  if (!status.configured)
    throw new Error(
      "iPhone Use 尚未設定。請先連接並信任 iPhone，在 Xcode 設定 Apple 開發團隊，完成 WDA 首次安裝。詳見 iPhone Use setup 指引。",
    );
  if (!status.service?.ready) {
    const latestBuild = [...(status.jobs || [])]
      .reverse()
      .find((row) => row.action === "build");
    if (latestBuild?.state === "failed")
      throw new Error(
        `WDA 建置失敗：${latestBuild.error || "請檢查 Xcode 簽名"} ${latestBuild.next_steps?.join("；") || "請在 Xcode Settings → Accounts 登入開發團隊後重新建置。"}`,
      );
    const job = status.jobs?.find(
      (row) =>
        ["queued", "running"].includes(row.state || "") &&
        ["start", "recover"].includes(row.action || ""),
    );
    let result: Setup;
    if (job)
      result = await phone.call<Setup>(
        "setup",
        { action: "status", job_id: job.id, wait_seconds: 20 },
        45000,
      );
    else if (status.service?.reachable === false)
      result = await phone.call<Setup>("setup", { action: "start" }, 45000);
    else
      throw new Error("WDA 狀態不明，請在 iPhone Use 檢查連線；未重複啟動服務");
    if (result.ok === false) throw new Error(result.error || "WDA 啟動失敗");
    const jobId = result.job_id || job?.id;
    for (let check = 0; !result.service?.ready && jobId && check < 2; check++) {
      result = await phone.call<Setup>(
        "setup",
        { action: "status", job_id: jobId, wait_seconds: 20 },
        45000,
      );
      if (result.ok === false) throw new Error(result.error || "WDA 啟動失敗");
    }
    if (!result.service?.ready)
      throw new Error(
        "WDA 仍在啟動或等待裝置信任；請稍後檢查連線，不會重複啟動",
      );
  }
  const ready = await phone.call<{
    ready?: boolean;
    observation?: PhoneObservation;
    state?: string;
  }>("ready", { recover: true, screenshot: false });
  if (!ready.ready || !ready.observation)
    throw new Error(
      `iPhone 尚未 READY：${ready.state || "請解鎖並確認 USB 連接"}`,
    );
  return ready.observation;
}

export async function observe(phone: IphoneMcp): Promise<PhoneObservation> {
  const result = await phone.call<PhoneObservation>("observe", {
    mode: "screenshot",
  });
  if (
    !result.image?.path ||
    !result.image.width ||
    !result.image.height ||
    !result.image.pixel_to_point
  )
    throw new Error("手機截圖缺少尺寸或座標比例");
  return result;
}

type Point = { x: number; y: number };
// Calibrated on the supported portrait Pokémon GO layout. These only navigate
// read-only scanning; transfer actions continue to use verified targets.
const scanPoint = {
  menu: { x: 0.865, y: 0.94 },
  appraise: { x: 0.69, y: 0.775 },
  appraisalDialog: { x: 0.5, y: 0.94 },
} as const;

export async function tapScan(
  phone: IphoneMcp,
  observation: PhoneObservation,
  point: Point,
) {
  if (!observation.image) throw new Error("沒有可用於點擊的手機截圖");
  const image = observation.image;
  const result = await phone.call<{ observation?: PhoneObservation }>("tap", {
    x: point.x * image.width * image.pixel_to_point[0],
    y: point.y * image.height * image.pixel_to_point[1],
    observation_id: observation.observation_id,
    observe: "screenshot",
  });
  return result.observation?.image?.pixel_to_point?.length === 2
    ? result.observation
    : observe(phone);
}

export async function swipeScan(
  phone: IphoneMcp,
  observation: PhoneObservation,
  direction: "up" | "left",
) {
  const result = await phone.call<{ observation?: PhoneObservation }>("swipe", {
    direction,
    observation_id: observation.observation_id,
    verify: false,
    observe: "screenshot",
  });
  return result.observation?.image?.pixel_to_point?.length === 2
    ? result.observation
    : observe(phone);
}

async function tapInitialTarget(
  phone: IphoneMcp,
  observation: PhoneObservation,
  target: Target,
) {
  const page = await classify(observation, target);
  if (
    page.page !== "collection" ||
    !page.targetClear ||
    !page.target
  )
    throw new Error(`盒子畫面找不到 ${target}，已暫停`);
  return tapScan(phone, observation, {
    x: page.target.x,
    y: 0.055 + page.target.y * (phoneVisionBottom(target) - 0.055),
  });
}

async function appraisalForScan(phone: IphoneMcp, initial: PhoneObservation) {
  let current = initial;
  let previous: string | null = null;
  let advances = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const measured = current.image?.path
      ? await measureIV(current.image.path)
      : null;
    if (measured?.confidence && measured.confidence >= 0.8) {
      const values = measured.values.join("/");
      if (values === previous) return current;
      previous = values;
      current = await observe(phone);
    } else {
      previous = null;
      if (advances >= 2) break;
      current = await tapScan(phone, current, scanPoint.appraisalDialog);
      advances++;
    }
  }
  throw new Error("評價條未穩定顯示，已暫停保留截圖進度");
}

async function dismissAppraisalForScan(
  phone: IphoneMcp,
  initial: PhoneObservation,
) {
  let current = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    current = await tapScan(phone, current, scanPoint.appraisalDialog);
    if (!current.image?.path || !(await measureIV(current.image.path)))
      return current;
    const latest = await observe(phone);
    if (!latest.image?.path || !(await measureIV(latest.image.path)))
      return latest;
    current = latest;
  }
  throw new Error("評價條仍顯示；已暫停避免切換錯誤個體");
}

export async function classify(
  observation: PhoneObservation,
  target: Target | null = null,
  redactLocation = false,
) {
  const page = await inspectObservation(observation, target, redactLocation);
  if (
    page.confidence < 0.8 ||
    page.hasUnexpectedOverlay ||
    page.page === "loading" ||
    page.page === "other"
  )
    throw new Error(`無法可靠辨識遊戲畫面：${page.title || page.page}，已暫停`);
  return page;
}

export async function tapTarget(
  phone: IphoneMcp,
  observation: PhoneObservation,
  target: Target,
  expected: PhonePage["page"][],
  redactLocation = false,
) {
  const page = await classify(observation, target, redactLocation);
  if (
    !expected.includes(page.page) ||
    !page.targetClear ||
    !page.target ||
    !observation.image
  )
    throw new Error(`畫面沒有唯一且可點的 ${target}，已暫停`);
  const image = observation.image;
  const x = page.target.x * image.width * image.pixel_to_point[0];
  const y =
    (0.055 + page.target.y * (phoneVisionBottom(target) - 0.055)) *
    image.height *
    image.pixel_to_point[1];
  await phone.call("tap", { x, y, observation_id: observation.observation_id });
  const nextPages: Partial<Record<Target, PhonePage["page"][]>> = {
    first_pokemon: ["detail"],
    menu: ["menu"],
    appraise: ["appraisal"],
    advance_appraisal: ["appraisal", "detail"],
    close_appraisal: ["detail"],
    unfavorite: ["detail"],
    clear_search: ["collection"],
    clear_filters: ["collection"],
    back_to_collection: ["collection"],
    transfer: ["transfer_dialog", "warning"],
    confirm_transfer: ["collection"],
  };
  let next = await observe(phone);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!next.image?.path) return next;
    const state = await inspectObservation(next);
    if (nextPages[target]?.includes(state.page) && state.confidence >= 0.8)
      return next;
    if (
      state.page !== "loading" &&
      !(state.page === "other" && /空白|過渡|載入/.test(state.title))
    )
      return next;
    next = await observe(phone);
  }
  return next;
}

export async function saveCapture(
  observation: PhoneObservation,
  scanId: string,
  name: string,
  appraisal = false,
  bottomRatio = 0.92,
) {
  if (!observation.image?.path) throw new Error("沒有手機畫面");
  const measurement = appraisal
    ? await measureIV(observation.image.path)
    : null;
  const iv = measurement?.values || null;
  const frame = await saveEvidenceFrame(
    observation.image.path,
    scanId,
    name,
    appraisal && measurement
      ? Math.min(
          0.88,
          (measurement.rows[2] * observation.image.width) /
            (600 * observation.image.height) +
            0.035,
        )
      : bottomRatio,
  );
  return { frame, iv };
}

export async function appraisalWithBars(
  phone: IphoneMcp,
  initial: PhoneObservation,
) {
  let current = initial;
  let previousValues: string | null = null;
  let advances = 0;
  for (let step = 0; step < 7; step++) {
    if ((await classify(current)).page !== "appraisal")
      throw new Error("評價畫面未開啟");
    const measured = current.image?.path
      ? await measureIV(current.image.path)
      : null;
    if (measured) {
      const values = measured.values.join("/");
      if (measured.confidence >= 0.8 && previousValues === values)
        return current;
      previousValues = measured.confidence >= 0.8 ? values : null;
      current = await observe(phone);
      continue;
    }
    previousValues = null;
    if (advances >= 2) break;
    current = await tapTarget(phone, current, "advance_appraisal", [
      "appraisal",
    ]);
    advances++;
  }
  throw new Error("隊長評價條未穩定顯示，已暫停避免誤讀 IV");
}

export async function closeAppraisal(
  phone: IphoneMcp,
  initial: PhoneObservation,
) {
  let current = initial;
  for (let step = 0; step < 3; step++) {
    const page = await classify(current);
    if (page.page === "detail") return current;
    if (page.page !== "appraisal")
      throw new Error("關閉評價時遊戲畫面不明，已暫停");
    const close = await classify(current, "close_appraisal");
    if (close.targetClear && close.target)
      current = await tapTarget(phone, current, "close_appraisal", [
        "appraisal",
      ]);
    else
      current = await tapTarget(phone, current, "advance_appraisal", [
        "appraisal",
      ]);
    // Appraisal dismissal animates through screens that still look like an
    // appraisal. Observe several times before deciding another tap is needed.
    for (let check = 0; check < 5; check++) {
      current = await observe(phone);
      if (!current.image?.path) continue;
      const after = await inspectObservation(current);
      if (
        after.page === "detail" &&
        after.confidence >= 0.8 &&
        !after.hasUnexpectedOverlay
      )
        return current;
      if (after.page === "collection")
        throw new Error("關閉評價後回到盒子，無法確認目前個體位置");
    }
  }
  throw new Error("無法安全關閉評價畫面，已暫停");
}

export async function identifyGame(phone: IphoneMcp, first: PhoneObservation) {
  const apps = await phone.call<{
    candidates?: {
      bundle_id: string;
      installed_verified: boolean;
      name: string;
    }[];
  }>("apps", { query: "Pokémon GO", source: "installed", limit: 10 });
  const match = apps.candidates?.find(
    (row) => row.installed_verified && /Pok[eé]mon GO/i.test(row.name),
  );
  if (!match)
    throw new Error("裝置未證實安裝 Pokémon GO，或無法讀取已安裝 App 清單");
  if (first.app === match.bundle_id)
    return first.image ? first : observe(phone);
  await phone.call("launch_app", { bundle_id: match.bundle_id, verify: true });
  return observe(phone);
}

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

export async function captureOne(
  phone: IphoneMcp,
  scan: Scan,
  detail: PhoneObservation,
) {
  const position = scan.scanned;
  const top = await saveCapture(
    detail,
    scan.id,
    `${String(position).padStart(6, "0")}-top`,
  );
  const fingerprint = await detailFingerprint(
    path.join(dataDir, "frames", top.frame),
  );
  if (scan.lastFingerprint === fingerprint)
    throw new Error("翻頁後名稱、CP 與 HP 畫面沒有進展，已暫停避免重複掃描");
  const lowerObservation = await swipeScan(phone, detail, "up");
  const lower = await saveCapture(
    lowerObservation,
    scan.id,
    `${String(position).padStart(6, "0")}-moves`,
    false,
    0.71,
  );
  const menu = await tapScan(phone, lowerObservation, scanPoint.menu);
  const appraisal = await appraisalForScan(
    phone,
    await tapScan(phone, menu, scanPoint.appraise),
  );
  const appCapture = await saveCapture(
    appraisal,
    scan.id,
    `${String(position).padStart(6, "0")}-iv`,
    true,
  );
  const item: ScanItem = {
    id: id(),
    scanId: scan.id,
    position,
    frame: top.frame,
    movesFrame: lower.frame,
    appraisalFrame: appCapture.frame,
    measuredIV: appCapture.iv,
    fingerprint,
    pokemonId: null,
    fields: null,
    issues: [],
    protectionClear: false,
    capturedAt: now(),
  };
  transaction(() => {
    put("scan_items", item.id, item);
    const current = get<Scan>("scans", scan.id)!;
    updateScan(scan.id, {
      scanned: current.scanned + 1,
      currentFrame: top.frame,
      lastFingerprint: fingerprint,
      stage: `已截圖 ${current.scanned + 1} 隻；完成截圖後開始解析`,
    });
  });
  return dismissAppraisalForScan(phone, appraisal);
}

type PreparedAnalysis = {
  recognized: OcrVisionResult;
  measuredAgain: IvMeasurement | null;
};

function recordAnalysisUsage(
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

async function prepareAnalysis(
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

export async function analyzeOne(
  scanId: string,
  item: ScanItem,
  prepared?: Promise<PreparedAnalysis>,
  recheckExisting = false,
  shinyReview?: NonNullable<ScanItem["shinyReview"]>,
) {
  if (item.pokemonId && !recheckExisting) return;
  if (!item.movesFrame || !item.appraisalFrame)
    throw new Error(`第 ${item.position + 1} 隻缺少完整截圖，已暫停解析`);
  const { recognized, measuredAgain } =
    await (prepared || prepareAnalysis(scanId, item, new AbortController().signal));
  const snapshot = getSnapshot();
  const { top: topResult, moves: lowerResult } = recognized;
  const evolutionSilhouette = recognized.visual.evolutionSilhouette;
  const maxStatus = recognized.visual.maxStatus;
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
  const moveState = specialStateFromMoves(fields);
  if (moveState.conflict)
    merged.issues.push("招式與暗影／淨化狀態衝突，請人工核對");
  else {
    fields.shadow = moveState.shadow;
    fields.purified = moveState.purified;
    if (fields.speciesId && moveState.signal && snapshot) {
      const base = fields.speciesId.replace(/_shadow$/, "");
      const wanted = moveState.signal === "frustration" ? `${base}_shadow` : base;
      if (snapshot.species[wanted]) fields.speciesId = wanted;
      else merged.issues.push("招式與物種形態無法對應，請人工核對");
    }
  }
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
  if (gender.conflict)
    merged.issues.push("畫面性別辨識與物種無性別資料衝突，請人工核對");
  if (!ivStable)
    merged.issues.push("本機 IV 條量測不穩定或與截圖檢查點不一致，請人工核對");
  if (!recognized.visual.detailClear)
    merged.issues.push("截圖未能確認為能力頁，請人工核對");
  if (recognized.visual.hasUnexpectedOverlay || recognized.visual.warningVisible)
    merged.issues.push("截圖出現遮擋或警告，請人工核對");
  if (
    topResult.fields.cp !== null &&
    appraisalResult.fields.cp !== null &&
    topResult.fields.cp !== appraisalResult.fields.cp
  )
    merged.issues.push("能力與評價頁 CP 不一致");
  if (
    topResult.fields.name &&
    appraisalResult.fields.name &&
    topResult.fields.name !== appraisalResult.fields.name
  )
    merged.issues.push("能力與評價頁名稱不一致");
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
  if (item.pokemonId) {
    const existing = get<Pokemon>("pokemon", item.pokemonId);
    const genderInferred =
      existing?.fields.gender === null && fields.gender === "genderless";
    const shinyInferred =
      existing?.fields.shiny === null &&
      fields.shiny !== null &&
      shinyReview?.verdict === (fields.shiny ? "shiny" : "normal");
    const shadowInferred =
      existing?.fields.shadow === null &&
      fields.shadow !== null &&
      moveState.signal !== null &&
      !moveState.conflict;
    const purifiedInferred =
      existing?.fields.purified === null &&
      fields.purified !== null &&
      moveState.signal !== null &&
      !moveState.conflict;
    const speciesInferred =
      Boolean(
        existing &&
          moveState.signal &&
          !moveState.conflict &&
          existing.fields.speciesId !== fields.speciesId &&
          existing.fields.speciesId?.replace(/_shadow$/, "") ===
            fields.speciesId?.replace(/_shadow$/, ""),
      );
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
          gender: genderInferred ? null : fields.gender,
          shiny: shinyInferred ? null : fields.shiny,
          shadow: shadowInferred ? null : fields.shadow,
          purified: purifiedInferred ? null : fields.purified,
          speciesId: speciesInferred ? existing.fields.speciesId : fields.speciesId,
        },
      ) &&
      (genderInferred || shinyInferred || shadowInferred || purifiedInferred || speciesInferred || (existing.fields.favorite === true && complete))
    )
      transaction(() => {
        const current = get<Scan>("scans", scanId)!;
        if (current.status !== "running" && current.status !== "completed")
          return;
        const verified =
          complete && blockingEvidenceIssues(existing.issues, fields).length === 0;
        put("pokemon", existing.id, {
          ...existing,
          fields: genderInferred || shinyInferred || shadowInferred || purifiedInferred || speciesInferred ? fields : existing.fields,
          verified,
          verification: verified ? "automatic" : null,
          updatedAt: now(),
        });
        if (genderInferred || shinyInferred || shadowInferred || purifiedInferred || speciesInferred)
          put("scan_items", item.id, {
            ...item,
            fields,
            shinyReview: shinyReview || item.shinyReview,
          });
        if (verified)
          updateScan(scanId, { review: Math.max(0, current.review - 1) });
      });
    return;
  }
  const observations: Observation[] = [
    item.frame,
    item.movesFrame,
    item.appraisalFrame,
  ].map((frame, index) => ({
    id: `${scanId}-${item.position}-${index}`,
    jobId: scanId,
    segment: item.id,
    frame,
    time: 0,
    video: "iPhone Use",
    fields: [topResult.fields, lowerResult.fields, appraisalResult.fields][index],
    issues: index === 2 ? merged.issues : [],
    ivMeasured: index === 2 ? item.measuredIV || null : null,
    kind: ["details", "details", "appraisal"][index],
    source: "iphone",
    capturedAt: item.capturedAt,
    scanItemId: item.id,
  }));
  const prior = listPokemon().filter(
    (p) => p.owned && matching(effective(p), fields) !== "different",
  );
  if (prior.length) merged.issues.push("疑似與既有個體重複，請人工核對");
  const pokemon: Pokemon = {
    id: id(),
    jobId: scanId,
    fields,
    overrides: {},
    sources: observations.map((o) => ({
      observationId: o.id,
      frame: o.frame,
      time: 0,
      video: "iPhone Use",
      fields: (Object.keys(o.fields) as (keyof Fields)[]).filter(
        (key) => o.fields[key] !== null,
      ),
      source: "iphone",
      capturedAt: item.capturedAt,
      scanItemId: item.id,
    })),
    issues: merged.issues,
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
      issues: merged.issues,
      protectionClear,
      evolutionSilhouette,
      maxStatus,
      favoriteRechecked: true,
    });
    updateScan(scanId, {
      analyzed: (current.analyzed || 0) + 1,
      review: current.review + Number(!pokemon.verified),
      stage: `已解析 ${(current.analyzed || 0) + 1} / ${current.scanned} 隻`,
    });
  });
}

async function recheckFavoriteRecords(scanId: string) {
  const favorites = scanItems(scanId).filter((item) => {
    const record = item.pokemonId
      ? get<Pokemon>("pokemon", item.pokemonId)
      : null;
    return !item.favoriteRechecked && record?.fields.favorite === true && !record.verified;
  });
  if (!favorites.length) {
    const review = scanItems(scanId).filter((item) => {
      const record = item.pokemonId
        ? get<Pokemon>("pokemon", item.pokemonId)
        : null;
      return record && !record.verified;
    }).length;
    updateScan(scanId, { review });
    return true;
  }
  let recheckedCount = 0;
  const rechecked = await processPreparedInOrder({
    items: favorites,
    needsPreparation: () => true,
    active: () => get<Scan>("scans", scanId)?.status === "running",
    prepare: async (item, signal) => {
      try {
        return await prepareAnalysis(scanId, item, signal);
      } catch {
        return null;
      }
    },
    consume: async (item, prepared) => {
      recheckedCount++;
      updateScan(scanId, {
        stage: `重新核對已標最愛 ${recheckedCount} / ${favorites.length} 隻`,
      });
      if (!prepared) return;
      try {
        await analyzeOne(scanId, item, Promise.resolve(prepared), true);
        if (get<Scan>("scans", scanId)?.status === "running")
          put("scan_items", item.id, { ...item, favoriteRechecked: true });
      } catch {
        // Keep this individual pending if its saved evidence cannot be rechecked.
      }
    },
    concurrency: Number.parseInt(process.env.POGO_ANALYSIS_CONCURRENCY || "6", 10),
  });
  if (!rechecked) return false;
  const review = scanItems(scanId).filter((item) => {
    const record = item.pokemonId
      ? get<Pokemon>("pokemon", item.pokemonId)
      : null;
    return record && !record.verified;
  }).length;
  updateScan(scanId, { review });
  reevaluate();
  return true;
}

/** Use two already saved moments and exact variant references; never touch the phone. */
export async function reviewUnknownShiny(
  scanId: string,
  allowCompleted = false,
) {
  const active = () => {
    const status = get<Scan>("scans", scanId)?.status;
    return status === "running" || (allowCompleted && status === "completed");
  };
  const snapshot = getSnapshot();
  if (!snapshot) return true;
  const candidates = scanItems(scanId).filter((item) => {
    if (item.shinyReview || !item.pokemonId || !item.appraisalFrame) return false;
    const record = get<Pokemon>("pokemon", item.pokemonId);
    const fields = record?.fields;
    return Boolean(
      record &&
      !record.verified &&
      !record.candidates.length &&
      !record.issues.length &&
      !Object.keys(record.overrides).length &&
      fields?.shiny === null &&
      fields.shadow === false &&
      fields.costume === null &&
      fields.speciesId &&
      snapshot.species[fields.speciesId],
    );
  });
  let processed = 0;
  const finished = await processPreparedInOrder({
    items: candidates,
    needsPreparation: () => true,
    active,
    prepare: async (item, signal) => {
      const record = get<Pokemon>("pokemon", item.pokemonId!);
      const species = record?.fields.speciesId && snapshot.species[record.fields.speciesId];
      if (!species || !item.appraisalFrame) return null;
      try {
        return await reviewShiny(
          species,
          path.join(dataDir, "frames", item.frame),
          path.join(dataDir, "frames", item.appraisalFrame),
          signal,
          (usage) => recordAnalysisUsage(scanId, usage),
        );
      } catch {
        return null;
      }
    },
    consume: async (item, result) => {
      processed++;
      updateScan(scanId, {
        stage: `比對已存畫面的色違狀態 ${processed} / ${candidates.length} 隻`,
      });
      if (!result) return;
      const proof: NonNullable<ScanItem["shinyReview"]> = {
        ...result,
        reviewedAt: now(),
      };
      if (proof.verdict !== "uncertain") {
        try {
          await analyzeOne(scanId, item, undefined, true, proof);
        } catch {
          return;
        }
      }
      const latest = get<ScanItem>("scan_items", item.id);
      if (latest) put("scan_items", item.id, { ...latest, shinyReview: proof });
    },
    concurrency: Number.parseInt(process.env.POGO_SHINY_REVIEW_CONCURRENCY || "6", 10),
  });
  const review = scanItems(scanId).filter((item) => {
    const record = item.pokemonId ? get<Pokemon>("pokemon", item.pokemonId) : null;
    return record && !record.verified;
  }).length;
  updateScan(scanId, { review });
  reevaluate();
  if (allowCompleted && get<Scan>("scans", scanId)?.status === "completed")
    updateScan(scanId, { stage: "截圖與解析完成，請檢查放生候選" });
  return finished;
}

export async function analyzeScan(scanId: string) {
  const items = scanItems(scanId);
  const initial = get<Scan>("scans", scanId)!;
  if (initial.expected !== null && items.length !== initial.expected)
    throw new Error("截圖數量與盒子總數不符，不能開始解析");
  if (items.length !== initial.scanned)
    throw new Error("逐隻截圖檢查點不完整，不能開始解析");
  const analyzed = items.filter((item) => item.pokemonId).length;
  if (initial.analyzed !== analyzed) updateScan(scanId, { analyzed });
  if (!(await recheckFavoriteRecords(scanId))) return;
  const finished = await processPreparedInOrder({
    items,
    needsPreparation: (item) => !item.pokemonId,
    active: () => get<Scan>("scans", scanId)?.status === "running",
    prepare: (item, signal) => prepareAnalysis(scanId, item, signal),
    consume: async (item, result) => analyzeOne(scanId, item, Promise.resolve(result)),
    concurrency: Number.parseInt(process.env.POGO_ANALYSIS_CONCURRENCY || "6", 10),
  });
  reevaluate();
  if (!finished) return;
  if (!(await recheckFavoriteRecords(scanId))) return;
  if (!(await reviewUnknownShiny(scanId))) return;
  if (get<Scan>("scans", scanId)?.status === "running")
    updateScan(scanId, {
      status: "completed",
      analyzed: items.length,
      stage: "截圖與解析完成，請檢查放生候選",
      error: null,
    });
}

export async function runScan(phone: IphoneMcp, initial: Scan) {
  let scan = updateScan(initial.id, {
    status: "running",
    stage: initial.phase === "analysis" ? "繼續解析已保存畫面" : "檢查 iPhone",
    iphoneUseVersion:
      initial.phase === "analysis"
        ? initial.iphoneUseVersion
        : iphoneUseVersion(),
  });
  if (scan.phase === "analysis") {
    await analyzeScan(scan.id);
    return;
  }
  if (
    scan.expected !== null &&
    scan.scanned >= scan.expected &&
    scanItems(scan.id).length === scan.scanned
  ) {
    updateScan(scan.id, {
      phase: "analysis",
      stage: "截圖完成，開始解析",
      error: null,
    });
    await analyzeScan(scan.id);
    return;
  }
  let current = await identifyGame(phone, await ensureReady(phone));
  let page = scan.scanned === 0 ? await classify(current) : null;
  if (scan.scanned === 0 && page?.page !== "collection")
    throw new Error("開始掃描前請在 Pokémon GO 開啟寶可夢盒子列表");
  if (page?.page === "collection") {
    if (scan.scope === "all") {
      if (page.searchActive) {
        current = await tapInitialTarget(phone, current, "clear_search");
        page = await classify(current);
      }
      if (page.filterActive) {
        current = await tapInitialTarget(phone, current, "clear_filters");
        page = await classify(current);
      }
      if (page.searchActive !== false || page.filterActive !== false)
        throw new Error("無法確認整個盒子的搜尋和篩選已清除");
    }
    scan = updateScan(scan.id, {
      expected: page.visibleCount,
      sort: page.sort,
      stage: "開始逐隻截圖",
    });
    current = await tapInitialTarget(phone, current, "first_pokemon");
  }
  while (true) {
    scan = get<Scan>("scans", scan.id)!;
    if (scan.status !== "running") return;
    if (scan.expected !== null && scan.scanned >= scan.expected) break;
    if (
      scan.expected === null &&
      scan.scanned > 0 &&
      scan.scanned % 100 === 0
    ) {
      updateScan(scan.id, {
        status: "paused",
        stage: `已截圖 ${scan.scanned} 隻；請確認範圍後繼續`,
        checkpointRequired: true,
      });
      return;
    }
    current = await captureOne(phone, scan, current);
    scan = get<Scan>("scans", scan.id)!;
    if (scan.expected !== null && scan.scanned >= scan.expected) break;
    current = await swipeScan(phone, current, "left");
  }
  updateScan(scan.id, {
    phase: "analysis",
    stage: "截圖完成，開始解析",
  });
  await analyzeScan(scan.id);
}
