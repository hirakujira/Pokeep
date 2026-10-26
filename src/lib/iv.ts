import sharp from "sharp";

export type IvMeasurement = {
  values: number[];
  rows: number[];
  left: number;
  right: number;
  confidence: number;
};

// Shared appraisal-bar measurement for direct iPhone screenshots.
export async function measureIV(
  input: Buffer | string,
): Promise<IvMeasurement | null> {
  const { data, info } = await sharp(input)
    .resize({ width: 600 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const orange = (x: number, y: number) => {
    const k = (y * w + x) * c,
      r = data[k],
      g = data[k + 1],
      b = data[k + 2];
    return r > 185 && r > g * 1.15 && g > 65 && b < 190;
  };
  const rail = (x: number, y: number) => {
    const k = (y * w + x) * c,
      r = data[k],
      g = data[k + 1],
      b = data[k + 2];
    return r > 198 && r < 235 && Math.abs(r - g) < 13 && Math.abs(g - b) < 13;
  };
  const rows: { y: number; left: number; right: number; end: number }[] = [];
  // Saved evidence is cropped at the bottom of the third bar, so its rows
  // can sit below 89% even though they sit higher in the live screenshot.
  for (let y = Math.floor(h * 0.54); y < Math.floor(h * 0.99); y++) {
    let start = -1,
      last = -1,
      gap = 0,
      end = -1;
    for (let x = Math.floor(w * 0.055); x < Math.floor(w * 0.49); x++) {
      if (orange(x, y) || rail(x, y)) {
        if (start < 0) start = x;
        last = x;
        gap = 0;
        if (orange(x, y)) end = x;
      } else if (start >= 0 && ++gap > 5) {
        if (
          last - start > w * 0.27 &&
          last - start < w * 0.39 &&
          start > w * 0.08 &&
          start < w * 0.17
        )
          rows.push({ y, left: start, right: last, end });
        start = -1;
        last = -1;
        end = -1;
        gap = 0;
      }
    }
    if (
      start >= 0 &&
      last - start > w * 0.27 &&
      last - start < w * 0.39 &&
      start > w * 0.08 &&
      start < w * 0.17
    )
      rows.push({ y, left: start, right: last, end });
  }
  const groups: (typeof rows)[] = [];
  for (const row of rows) {
    const prev = groups.at(-1);
    if (prev && row.y - prev.at(-1)!.y < 8) prev.push(row);
    else groups.push([row]);
  }
  const candidates = groups
    .filter((g) => g.length >= 3)
    .map((g) => g[Math.floor(g.length / 2)]);
  for (let i = 0; i < candidates.length - 2; i++) {
    const bars = candidates.slice(i, i + 3),
      d1 = bars[1].y - bars[0].y,
      d2 = bars[2].y - bars[1].y;
    if (
      Math.abs(d1 - d2) > 6 ||
      d1 < h * 0.025 ||
      d1 > h * 0.07 ||
      Math.max(...bars.map((b) => b.left)) -
        Math.min(...bars.map((b) => b.left)) >
        6
    )
      continue;
    const ratios = bars.map(
        (b) => Math.max(0, (b.end - b.left + 1) / (b.right - b.left + 1)) * 15,
      ),
      values = ratios.map((v) => Math.min(15, Math.round(v)));
    const deviation = Math.max(
      ...ratios.map((v, j) => Math.abs(v - values[j])),
    );
    if (deviation > 0.4) return null;
    return {
      values,
      rows: bars.map((b) => b.y),
      left: bars[0].left,
      right: bars[0].right,
      confidence: 1 - deviation,
    };
  }
  return null;
}
