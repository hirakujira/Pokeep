import sharp from "sharp";
import type { OcrLine } from "./local-ocr";

/**
 * The evolve button contains a muted green silhouette for a Pokédex entry
 * that has not been registered. Return null unless the icon can be isolated
 * and its palette clearly matches either the silhouette or a coloured sprite.
 */
export async function evolutionSilhouette(
  file: string,
  lines: OcrLine[],
  ambiguousOutcome = false,
): Promise<boolean | "unavailable" | "unknown-branch" | null> {
  const evolves = lines.filter(
    (line) =>
      line.text.trim() === "進化" &&
      line.confidence >= 0.25 &&
      line.x > 0.15 &&
      line.x < 0.42 &&
      line.y > 0.15 &&
      line.y < 0.75,
  );
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height || meta.width >= meta.height) return null;
  // Vision sometimes reads the candy price but drops the evolve label. In the
  // supported portrait layout, the evolve button follows the power-up button.
  // Require both a price and a colored button before using that fallback.
  if (!evolves.length) {
    for (const powerUp of lines.filter((line) =>
      line.text.trim() === "強化" && line.confidence >= 0.3 &&
      line.x > 0.15 && line.x < 0.42
    )) {
      const y = powerUp.y - 0.092;
      if (y <= 0.15 || y >= 0.75 ||
          lines.some((line) => Math.abs(line.y - y) < 0.035 &&
            /(超級|極巨|淨化)/.test(line.text)) ||
          !lines.some((line) => Math.abs(line.y - y) < 0.035 &&
            line.x > 0.5 && line.x < 0.9 && /\d/.test(line.text)))
        continue;
      const region = {
        left: Math.round(meta.width * 0.36),
        top: Math.round(meta.height * (1 - y - 0.02)),
        width: Math.round(meta.width * 0.07),
        height: Math.round(meta.height * 0.04),
      };
      if (region.top < 0 || region.top + region.height > meta.height) continue;
      const { data, info } = await sharp(file)
        .extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let buttonPixels = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        if ((green > 120 && green > red * 1.15 && green > blue * 0.9) ||
            (red > 190 && red > green * 1.12 && blue > 135))
          buttonPixels++;
      }
      if (buttonPixels / (region.width * region.height) >= 0.5)
        evolves.push({ text: "進化", confidence: 0.25, x: 0.29, y });
    }
  }
  if (!evolves.length) {
    // A fully visible moves panel with the new-attack button immediately
    // below power-up leaves no room for an evolution row. Missing OCR text
    // alone is insufficient evidence that the button does not exist.
    const powerUps = lines.filter((line) =>
      line.text.trim() === "強化" && line.confidence >= 0.3 &&
      line.x > 0.15 && line.x < 0.42,
    );
    const newMoves = lines.filter((line) =>
      line.text.trim() === "新攻擊招式" && line.confidence >= 0.3 &&
      line.x > 0.1 && line.x < 0.42,
    );
    if (powerUps.some((powerUp) => newMoves.some((newMove) => {
      const gap = powerUp.y - newMove.y;
      return gap >= 0.27 && gap <= 0.36;
    }))) return "unavailable";
    return null;
  }
  // The question mark is a visible outcome, distinct from an unreadable icon.
  if (evolves.some((evolve) => lines.some((line) =>
    /^[?？]$/.test(line.text.trim()) && line.confidence >= 0.25 &&
    line.x > 0.14 && line.x < 0.24 &&
    Math.abs(line.y - evolve.y) < 0.04,
  ))) return "unknown-branch";
  let sawColored = false;
  let sawUnknown = false;
  for (const evolve of evolves) {
    // Vision's x is the centre of recognized text, sometimes including the
    // icon. The icon itself stays at the same place in this portrait layout.
    const left = Math.round(meta.width * 0.17);
    const top = Math.round(meta.height * (1 - evolve.y - 0.058));
    const width = Math.round(meta.width * 0.11);
    const height = Math.round(meta.height * 0.07);
    if (
      left < 0 || top < 0 ||
      left + width > meta.width || top + height > meta.height
    ) {
      sawUnknown = true;
      continue;
    }
    const { data, info } = await sharp(file)
      .extract({ left, top, width, height })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let darkGreen = 0;
    let colorful = 0;
    let pink = 0;
    let mutedPink = 0;
    let richPink = 0;
    let darkPink = 0;
    let otherHue = 0;
    let paleTeal = 0;
    let mutedTeal = 0;
    let otherDark = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (
        green > 90 && green < 185 &&
        red / green > 0.45 && red / green < 0.78 &&
        blue / green > 0.52 && blue / green < 0.85
      ) darkGreen++;
      if (
        (red > green * 1.25 && red > blue * 1.15) ||
        (blue > green * 1.1 && blue > red * 1.2)
      ) colorful++;
      if (
        red > 235 && green > 175 && blue > 200 &&
        red - green > 35 && blue - green > 10
      ) pink++;
      const brightMagenta =
        red > 190 && red < 255 && green > 100 && green < 170 &&
        blue > 150 && blue < 220 && red - green > 65 &&
        blue - green > 25;
      const darkMagenta =
        red > 120 && red < 200 && green > 55 && green < 130 &&
        blue > 95 && blue < 180 && red - green > 45 &&
        blue - green > 25;
      if (brightMagenta) richPink++;
      else if (darkMagenta) darkPink++;
      else if (
        red < 220 && green < 220 && blue < 220 &&
        (green > red * 1.15 || blue > red * 1.2)
      ) otherHue++;
      if (
        red > 175 && red < 225 && green > 195 && green < 245 &&
        blue > 195 && blue < 245 && green - red > 10 &&
        Math.abs(green - blue) < 22
      ) paleTeal++;
      if (
        red > 105 && red < 170 && green > 125 && green < 190 &&
        blue > 120 && blue < 190 && green - red > 8 &&
        green - red < 42 && Math.abs(green - blue) < 30
      ) mutedTeal++;
      if (red < 225 && green < 185 && blue < 210) {
        if (
          red - green > 20 && red - green < 70 &&
          blue - green > 5 && blue - green < 50
        ) mutedPink++;
        else otherDark++;
      }
    }
    const area = width * height;
    // Disabled evolution buttons are pink. Their unregistered silhouette is
    // the same hue as the button, only darker; registered sprites retain color.
    if (
      (pink + mutedPink) / area >= 0.85 &&
      mutedPink / area >= 0.04 &&
      otherDark / area <= 0.02 && colorful / area <= 0.02
    ) return true;
    // Some item-based evolution buttons use a deeper magenta than the
    // multi-branch calibration. The unregistered icon is one dark-magenta
    // silhouette with almost no differently coloured sprite pixels.
    if (
      richPink / area >= 0.55 && darkPink / area >= 0.08 &&
      otherHue / area <= 0.02
    ) return true;
    // The disabled one-branch evolve button is pale teal. Its unregistered
    // silhouette is a single darker, desaturated teal shape.
    if (
      paleTeal / area >= 0.35 && mutedTeal / area >= 0.08 &&
      colorful / area <= 0.01
    ) return true;
    // Small species silhouettes cover less of the button than the initial
    // calibration sample (e.g. Smoliv's next evolution is about 6.8%).
    if (darkGreen / area >= 0.06 && colorful / area <= 0.01) return true;
    if ((colorful / area >= 0.025 && darkGreen / area < 0.08) ||
        (otherDark / area >= 0.025 && darkGreen / area < 0.04))
      sawColored = true;
    else sawUnknown = true;
  }
  // A '?' for a random evolution outcome is not a registered sprite. The
  // species data distinguishes these ambiguous branches from a single result.
  return sawUnknown ? null : sawColored && !ambiguousOutcome ? false : null;
}
