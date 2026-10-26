import type { OcrLine } from "./local-ocr";

/** Read only the Pokémon GO caught-date badge from locally stored evidence. */
export function caughtDateBadge(lines: OcrLine[]) {
  const year = lines.filter(
    (line) =>
      line.x > 0.7 &&
      line.confidence >= 0.8 &&
      /^20\d{2}$/.test(line.text.trim()),
  );
  const monthDay = lines.filter(
    (line) =>
      line.x > 0.7 &&
      line.confidence >= 0.4 &&
      /^\d{1,2}\/\d{1,2}$/.test(line.text.trim()),
  );
  if (year.length !== 1 || monthDay.length !== 1) return null;
  if (Math.abs(year[0].y - monthDay[0].y) > 0.08) return null;
  const [month, day] = monthDay[0].text.split("/").map(Number);
  const value = `${year[0].text}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return Number.isFinite(Date.parse(value)) ? value : null;
}
