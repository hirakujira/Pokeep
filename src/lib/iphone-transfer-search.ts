import type { OcrLine } from "./local-ocr";
import { effective, type Pokemon, type Snapshot } from "./types";

export type CpCandidate = {
  cp: number;
  x: number;
  y: number;
};

/** The top box title and search row are stable on the supported portrait UI. */
export function collectionSearchState(lines: OcrLine[]): "empty" | "active" | null {
  const title = lines.some(
    (line) =>
      line.text.trim() === "寶可夢" &&
      line.x > 0.3 && line.x < 0.65 &&
      line.y > 0.86 && line.y < 0.94,
  );
  const search = lines.find(
    (line) =>
      line.x > 0.1 && line.x < 0.65 &&
      line.y > 0.78 && line.y < 0.85 &&
      /搜尋|[A-Za-z0-9\u4e00-\u9fff]/.test(line.text),
  );
  if (!title) return null;
  if (!search) {
    // On the current box UI an empty field sometimes contains only the
    // magnifying-glass icon, which local OCR does not report as text.
    const boxCount = lines.some((line) =>
      line.x > 0.3 && line.x < 0.65 &&
      line.y > 0.85 && line.y < 0.92 &&
      /^\d{1,5}\s*\/\s*\d{1,5}$/.test(line.text.trim()),
    );
    return boxCount ? "empty" : null;
  }
  return search.text.includes("搜尋") ? "empty" : "active";
}

export function searchQueryMatches(lines: OcrLine[], dex: number): boolean {
  const search = lines.find(
    (line) => line.x > 0.1 && line.x < 0.65 && line.y > 0.78 && line.y < 0.85,
  );
  if (search && /[&!a-z]/i.test(search.text.replace(/^[Qq]\s*/, ""))) return false;
  const digits = search?.text.match(/[0-9]+/g);
  // Vision may read the magnifying-glass icon as a stray one-digit number.
  return Boolean(
    digits &&
    digits.at(-1) === String(dex) &&
    digits.slice(0, -1).every((part) => part.length === 1) &&
    digits.length <= 2,
  );
}

/** Keep background Pokémon out of the result list used for transfer. */
export function nonBackgroundQuery(dex: number) {
  if (!Number.isInteger(dex) || dex < 1 || dex > 10000)
    throw new Error("沒有可靠的圖鑑編號，無法排除特殊背卡");
  return `${dex}&!背卡`;
}

export function nonBackgroundQueryMatches(lines: OcrLine[], dex: number) {
  const search = lines.find(
    (line) => line.x > 0.1 && line.x < 0.65 &&
      line.y > 0.78 && line.y < 0.85,
  );
  const text = search?.text.normalize("NFKC").toLowerCase().replace(/\s/g, "") || "";
  const query = nonBackgroundQuery(dex);
  const prefix = text.slice(0, -query.length);
  return text.endsWith(query) && ["", "q", "⌕", "🔍"].includes(prefix);
}

/** Cropped search text has no magnifier prefix or position in the full frame. */
export function croppedNonBackgroundQueryMatches(lines: OcrLine[], dex: number) {
  const visible = lines.map((line) => line.text.normalize("NFKC").replace(/\s/g, ""))
    .filter(Boolean);
  return visible.length === 1 && visible[0] === nonBackgroundQuery(dex);
}

export function croppedNonBackgroundConsensus(readings: OcrLine[][], dex: number) {
  return readings.length === 3 &&
    readings.filter((lines) => croppedNonBackgroundQueryMatches(lines, dex)).length >= 2;
}

export function croppedBackgroundTextCompatible(readings: OcrLine[][], dex: number) {
  const query = `${dex}&背卡`;
  return readings.some((lines) => {
    const visible = lines.map((line) => line.text.normalize("NFKC").replace(/\s/g, ""))
      .filter(Boolean);
    return visible.length === 1 &&
      visible[0].replace(/[!.]/g, "") === query;
  });
}

/** Look up rare backgrounds with a positive query before the ordinary dex search. */
export function backgroundQuery(dex: number) {
  if (!Number.isInteger(dex) || dex < 1 || dex > 10000)
    throw new Error("沒有可靠的圖鑑編號，無法檢查特殊背卡");
  return `${dex}&背卡`;
}

export function backgroundQueryMatches(lines: OcrLine[], dex: number) {
  const search = lines.find(
    (line) => line.x > 0.1 && line.x < 0.65 &&
      line.y > 0.78 && line.y < 0.85,
  );
  const text = search?.text.normalize("NFKC").toLowerCase().replace(/\s/g, "") || "";
  const query = backgroundQuery(dex);
  const prefix = text.slice(0, -query.length);
  return text.endsWith(query) && ["", "q", "⌕", "🔍"].includes(prefix);
}

/** A partial or unreadable result must not clear a candidate for transfer. */
export function backgroundSearchDecision(
  lines: OcrLine[], dex: number, targetCp: number,
): "clear" | "protected" | "unknown" {
  if (!backgroundQueryMatches(lines, dex)) return "unknown";
  const count = searchResultCount(lines);
  if (count === null) return "unknown";
  if (count === 0) return "clear";
  const visible = cpCandidates(lines);
  if (visible.some((candidate) => candidate.cp === targetCp)) return "protected";
  return visible.length >= count ? "clear" : "unknown";
}

export function searchResultCount(lines: OcrLine[]): number | null {
  const header = lines.find(
    (line) =>
      line.y > 0.82 &&
      line.y < 0.93 &&
      line.x > 0.3 &&
      line.x < 0.65 &&
      /[（(]\d{1,5}[)）]/.test(line.text),
  );
  const match = header?.text.match(/[（(](\d{1,5})[)）]/);
  return match ? Number(match[1]) : null;
}

export function detailCp(lines: OcrLine[]): number | null {
  const values = lines
    .filter((line) => line.y > 0.7 && line.y < 0.995)
    .flatMap((line) => {
      const match = line.text.match(/\bCP\s*([0-9][0-9,]*)\b/i);
      return match ? [Number(match[1].replaceAll(",", ""))] : [];
    });
  return values.length === 1 ? values[0] : null;
}

/** Only the ordinary one-Pokémon transfer prompt may be confirmed. */
export function standardTransferDialog(lines: OcrLine[]): boolean {
  const content = lines
    .filter((line) => line.y > 0.3 && line.y < 0.7)
    .sort((a, b) => b.y - a.y)
    .map((line) => ({
      text: line.text.replace(/\s+/g, "").toUpperCase(),
      x: line.x,
      y: line.y,
    }));
  const titleLines = content.length - 3;
  return (
    (titleLines === 1 || titleLines === 2) &&
    /^確定要將.+傳送給博士[？?]$/.test(content.slice(0, titleLines).map((line) => line.text).join("")) &&
    content[titleLines].text === "傳送後將無法取消" &&
    content[titleLines + 1].text === "YES" &&
    (content[titleLines + 2].text === "NO" || (
      content[titleLines + 2].text === "ZO" &&
      content[titleLines + 2].x > 0.4 && content[titleLines + 2].x < 0.6 &&
      content[titleLines + 2].y > 0.34 && content[titleLines + 2].y < 0.42
    ))
  );
}

/** Pokémon GO box cards put CP above the sprite in a three-column grid. */
export function cpCandidates(lines: OcrLine[]): CpCandidate[] {
  const found: CpCandidate[] = [];
  for (const line of lines) {
    if (line.y < 0.1 || line.y > 0.79) continue;
    let match = line.text.match(/\bCP\s*([0-9][0-9,]*)\b/i);
    if (!match && /^CP$/i.test(line.text.trim())) {
      const number = lines.find(
        (other) =>
          /^[0-9][0-9,]*$/.test(other.text.trim()) &&
          Math.abs(other.y - line.y) < 0.025 &&
          other.x > line.x &&
          other.x - line.x < 0.17,
      );
      match = number ? [line.text, number.text] : null;
    }
    if (!match) continue;
    const cp = Number(match[1].replaceAll(",", ""));
    const x = line.x < 0.34 ? 0.17 : line.x < 0.67 ? 0.5 : 0.83;
    const y = 1 - line.y + 0.09;
    if (cp >= 10 && cp <= 15000 && y < 0.92)
      found.push({ cp, x, y });
  }
  return found;
}

export function assertUniqueDexCp(
  target: Pokemon,
  records: Pokemon[],
  snapshot: Snapshot | null,
  completeBoxIds: Set<string> | null,
) {
  if (!snapshot || !completeBoxIds?.has(target.id))
    throw new Error("沒有涵蓋此個體的完整盒子掃描，無法只靠 CP 放生");
  const fields = effective(target);
  const dex = fields.speciesId && snapshot.species[fields.speciesId]?.dex;
  if (!dex || fields.cp === null)
    throw new Error("缺少圖鑑編號或 CP，無法搜尋放生個體");
  const matches = records.filter((record) => {
    const value = effective(record);
    return (
      record.owned &&
      completeBoxIds.has(record.id) &&
      value.cp === fields.cp &&
      Boolean(
        value.speciesId && snapshot.species[value.speciesId]?.dex === dex,
      )
    );
  });
  if (matches.length !== 1 || matches[0].id !== target.id)
    throw new Error("完整盒子中有多隻相同圖鑑編號與 CP，需人工辨識");
  return { dex, cp: fields.cp };
}
