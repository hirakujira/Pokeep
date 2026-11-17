import fs from "node:fs/promises";
import path from "node:path";
import type { PhoneConnection } from "../phone-connection";
import { saveEvidenceFrame } from "../frame-evidence";
import { measureIV } from "../iv";
import { detailFingerprint } from "../iphone-fingerprint";
import { readLocalOcr, type OcrLine } from "../local-ocr";
import { dataDir, get, id, listPokemon, now, put, transaction } from "../store";
import { effective, type Pokemon } from "../types";
import { updateScan } from "../iphone-data";
import type { Scan, ScanItem } from "../iphone-types";
import type { PhoneObservation } from "./phone";
import { blindNavigation, scanPoint, swipeScan, tapScan } from "./gestures";
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

/** CP and max HP read from the detail page plus the measured IV must all equal an owned record. */
export function knownPokemon(
  lines: OcrLine[],
  iv: number[] | null,
  scanId: string,
  pokemon: Pokemon[] = listPokemon(),
) {
  const text = lines.map((line) => line.text).join(" ");
  const cp = text.match(/CP\s*([0-9][0-9,]*)/i)?.[1]?.replace(/,/g, "");
  const hp = text.match(/\d+\s*\/\s*(\d+)\s*HP|HP\s*\d+\s*\/\s*(\d+)/i);
  const maxHp = hp?.[1] ?? hp?.[2];
  if (!cp || !maxHp || !iv || iv.length !== 3) return null;
  return pokemon.find((p) => {
    const f = effective(p);
    return p.owned && p.jobId !== scanId && f.cp === Number(cp) &&
      f.hp === Number(maxHp) && f.ivAtk === iv[0] && f.ivDef === iv[1] && f.ivSta === iv[2];
  }) ?? null;
}

export async function captureOne(
  phone: PhoneConnection,
  scan: Scan,
  detail: PhoneObservation,
) {
  const blind = blindNavigation(phone);
  // Blind dismissal is only confirmed by this screenshot of the next Pokémon.
  if (blind && detail.image?.path && (await measureIV(detail.image.path)))
    throw new Error("評價條仍顯示；已暫停避免切換錯誤個體");
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
  const menu = await tapScan(phone, lowerObservation, scanPoint.menu, { blind });
  // The appraisal always opens on the leader's intro, so a blind tap leaves
  // appraisalForScan to tap through it and screenshot the bars.
  const appraisal = await appraisalForScan(
    phone,
    await tapScan(phone, menu, scanPoint.appraise, { blind }),
  );
  const appCapture = await saveCapture(
    appraisal,
    scan.id,
    `${String(position).padStart(6, "0")}-iv`,
    true,
  );
  if (scan.scope === "latest") {
    const topPath = path.join(dataDir, "frames", top.frame);
    if (knownPokemon((await readLocalOcr([topPath]))[0], appCapture.iv, scan.id)) {
      // This one is already stored; keep only the newer catches before it.
      await Promise.allSettled([top.frame, lower.frame, appCapture.frame].map((frame) =>
        fs.rm(path.join(dataDir, "frames", frame), { force: true })));
      const current = get<Scan>("scans", scan.id)!;
      updateScan(scan.id, {
        expected: current.scanned,
        stage: `第 ${current.scanned + 1} 隻已在資料庫，停止截圖`,
      });
      return dismissAppraisalForScan(phone, appraisal);
    }
  }
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
