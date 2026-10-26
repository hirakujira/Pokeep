import { createHash } from "node:crypto";
import sharp from "sharp";

/** Hash the static CP and name/HP regions; animated sprites cannot prove a page turn. */
export async function detailFingerprint(file: string) {
  const meta = await sharp(file).metadata();
  if (!meta.width || !meta.height) throw new Error("無法讀取能力畫面尺寸");
  const hash = createHash("sha256");
  for (const region of [
    { left: 0.24, top: 0, width: 0.52, height: 0.07 },
    { left: 0.18, top: 0.37, width: 0.64, height: 0.14 },
  ]) {
    const left = Math.floor(meta.width * region.left);
    const top = Math.floor(meta.height * region.top);
    const width = Math.floor(meta.width * region.width);
    const height = Math.floor(meta.height * region.height);
    hash.update(
      await sharp(file)
        .extract({ left, top, width, height })
        .resize(96, 24)
        .greyscale()
        .threshold(165)
        .raw()
        .toBuffer(),
    );
  }
  return hash.digest("hex");
}
