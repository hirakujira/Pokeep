import path from "node:path";
import type { IphoneMcp } from "../iphone-mcp";
import { saveEvidenceFrame } from "../frame-evidence";
import { measureIV } from "../iv";
import { detailFingerprint } from "../iphone-fingerprint";
import { dataDir, get, id, now, put, transaction } from "../store";
import { updateScan } from "../iphone-data";
import type { Scan, ScanItem } from "../iphone-types";
import type { PhoneObservation } from "./phone";
import { scanPoint, swipeScan, tapScan } from "./gestures";
import { appraisalForScan, dismissAppraisalForScan } from "./appraisal";

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
      stage: current.scanned + 1 >= 20
        ? `已截圖 ${current.scanned + 1} 隻；同步解析 ${current.analyzed} 隻`
        : `已截圖 ${current.scanned + 1} 隻；累積 20 隻後開始解析`,
    });
  });
  return dismissAppraisalForScan(phone, appraisal);
}
