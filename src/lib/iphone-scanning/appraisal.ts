import type { IphoneMcp } from "../iphone-mcp";
import { measureIV } from "../iv";
import {
  classify,
  inspectObservation,
  observe,
  type PhoneObservation,
} from "./phone";
import { scanPoint, tapScan, tapTarget } from "./gestures";

export async function appraisalForScan(phone: IphoneMcp, initial: PhoneObservation) {
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

export async function dismissAppraisalForScan(
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
