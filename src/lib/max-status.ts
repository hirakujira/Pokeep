import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { readLocalOcr } from "./local-ocr";
import type { OcrLine } from "./local-ocr";

export type MaxStatus = "none" | "dynamax" | "gigantamax";

type BadgePixels = { pink: number; white: number };

function badgeText(texts: string[]): MaxStatus | null {
  if (texts.some((text) => /超極巨化|GIGANTAMAX/i.test(text))) return "gigantamax";
  if (texts.some((text) => /極巨化|DYNAMAX/i.test(text))) return "dynamax";
  return null;
}

/** Read the badge between the type row and the resource row on a detail page. */
export function maxStatusFromOcr(lines: OcrLine[]): MaxStatus | null {
  const inBadge = (line: OcrLine) =>
    line.confidence >= 0.35 && line.y > 0.27 && line.y < 0.37 &&
    line.x > 0.25 && line.x < 0.65;
  const badge = lines.filter(inBadge).map((line) => line.text.replace(/\s/g, ""));
  const recognized = badgeText(badge);
  if (recognized) return recognized;
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

/** Confirm that the badge slot is an unobscured white detail card. */
export function maxStatusFromEvidence(lines: OcrLine[], pixels: BadgePixels): MaxStatus | null {
  const recognized = maxStatusFromOcr(lines);
  if (pixels.pink >= 0.1)
    return recognized === "dynamax" || recognized === "gigantamax" ? recognized : null;
  if (recognized === "dynamax" || recognized === "gigantamax") return null;
  if (pixels.white < 0.85 || pixels.pink >= 0.05) return null;
  const at = (line: OcrLine, low: number, high: number) =>
    line.y > low && line.y < high;
  const hp = lines.some((line) => at(line, 0.44, 0.55) &&
    /\d+\s*\/\s*\d+\s*HP/i.test(line.text));
  const weight = lines.some((line) => at(line, 0.35, 0.44) &&
    /\d+(?:\.\d+)?\s*kg/i.test(line.text));
  const height = lines.some((line) => at(line, 0.35, 0.44) &&
    /\d+(?:\.\d+)?\s*m\b/i.test(line.text));
  const resources = lines.some((line) => at(line, 0.18, 0.35) &&
    /星星沙子|STARDUST/i.test(line.text));
  const powerUp = lines.some((line) => at(line, 0.02, 0.28) &&
    /強化|POWER\s*UP/i.test(line.text));
  const cp = lines.some((line) => /\bCP\s*\d+/i.test(line.text));
  const types = lines.some((line) => at(line, 0.34, 0.43) &&
    /[\p{Script=Han}]+\s*[／/]\s*[\p{Script=Han}]+/u.test(line.text));
  return hp && weight && height && ((resources && powerUp) || (cp && types))
    ? "none" : null;
}

export async function maxStatusFromScreenshot(file: string, lines: OcrLine[]) {
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height || meta.width >= meta.height) return null;
  const region = {
    left: Math.round(meta.width * 0.3),
    top: Math.round(meta.height * 0.65),
    width: Math.round(meta.width * 0.16),
    height: Math.round(meta.height * 0.08),
  };
  const { data, info } = await sharp(file).extract(region).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let pink = 0, white = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
    if (red > 100 && red > green * 1.3 && blue > green * 1.25 && blue > 50)
      pink++;
    if (red > 225 && green > 225 && blue > 225) white++;
  }
  const pixels = {
    pink: pink / (info.width * info.height),
    white: white / (info.width * info.height),
  };
  const status = maxStatusFromEvidence(lines, pixels);
  if (pixels.pink < 0.1 || status !== null) return status;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pokeep-max-badge-"));
  try {
    const badgeFile = path.join(temporary, "badge.png");
    await sharp(file).extract({
      left: Math.round(meta.width * 0.25),
      top: Math.round(meta.height * 0.65),
      width: Math.round(meta.width * 0.5),
      height: Math.round(meta.height * 0.09),
    }).resize({ width: 1200 }).png().toFile(badgeFile);
    const [badgeLines] = await readLocalOcr([badgeFile]);
    return badgeText(badgeLines.map((line) => line.text.replace(/\s/g, "")));
  } catch {
    return null;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
