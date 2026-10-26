import sharp from "sharp";

type InkRun = { start: number; end: number; minY: number; maxY: number };

/** The supported portrait search font renders ! as a narrow, full-height glyph. */
export function hasExclamationRun(runs: InkRun[], imageWidth: number, imageHeight: number) {
  const tail = runs.slice(-3);
  if (tail.length !== 3) return false;
  const [mark, firstHan, secondHan] = tail;
  const width = (run: InkRun) => run.end - run.start + 1;
  const markHeight = mark.maxY - mark.minY + 1;
  return width(mark) >= 2 && width(mark) <= Math.round(imageWidth * 0.012) &&
    markHeight >= Math.round(imageHeight * 0.009) &&
    width(firstHan) >= Math.round(imageWidth * 0.02) &&
    width(secondHan) >= Math.round(imageWidth * 0.02) &&
    firstHan.start - mark.end <= Math.round(imageWidth * 0.015) &&
    secondHan.start - firstHan.end <= Math.round(imageWidth * 0.015);
}

export async function hasBackgroundExclamationGlyph(file: string) {
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height || meta.width >= meta.height) return false;
  const left = Math.round(meta.width * 0.24);
  const top = Math.round(meta.height * 0.168);
  const width = Math.round(meta.width * 0.3);
  const height = Math.round(meta.height * 0.028);
  const { data, info } = await sharp(file)
    .extract({ left, top, width, height })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
  const runs: InkRun[] = [];
  let current: InkRun | null = null;
  for (let x = 0; x < width; x++) {
    let count = 0, minY = height, maxY = 0;
    for (let y = 0; y < height; y++) {
      if (data[y * info.width + x] >= 150) continue;
      count++;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (count >= 2) {
      if (current) {
        current.end = left + x;
        current.minY = Math.min(current.minY, minY);
        current.maxY = Math.max(current.maxY, maxY);
      } else current = { start: left + x, end: left + x, minY, maxY };
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);
  return hasExclamationRun(runs, meta.width, meta.height);
}
