import type { OcrLine } from "./local-ocr";

export type MaxStatus = "none" | "dynamax" | "gigantamax";

/** Read the badge between the type row and the resource row on a detail page. */
export function maxStatusFromOcr(lines: OcrLine[]): MaxStatus | null {
  const inBadge = (line: OcrLine) =>
    line.confidence >= 0.35 && line.y > 0.27 && line.y < 0.37 &&
    line.x > 0.25 && line.x < 0.65;
  const badge = lines.filter(inBadge).map((line) => line.text.replace(/\s/g, ""));
  if (badge.some((text) => /超極巨化|GIGANTAMAX/i.test(text)))
    return "gigantamax";
  if (badge.some((text) => /極巨化|DYNAMAX/i.test(text)))
    return "dynamax";
  const hasDetail = lines.some((line) => /\bCP\s*\d+/i.test(line.text)) &&
    lines.some((line) => /\d+\s*\/\s*\d+\s*HP/i.test(line.text));
  const hasResources = lines.some((line) =>
    /星星沙子|STARDUST/i.test(line.text) && line.y > 0.18 && line.y < 0.34,
  );
  const hasPowerUp = lines.some((line) =>
    /強化|POWER\s*UP/i.test(line.text) && line.y > 0.1 && line.y < 0.27,
  );
  return hasDetail && hasResources && hasPowerUp ? "none" : null;
}
