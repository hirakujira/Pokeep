import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { dataDir } from "./store";

/** Store direct phone captures in the private evidence directory. */
export async function saveEvidenceFrame(
  source: string,
  jobId: string,
  fileName: string,
  bottomRatio = 0.92,
) {
  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height || meta.width >= meta.height)
    throw new Error("僅支援直式 iPhone 畫面");
  // Keep the area above CP: Pokémon GO can show its Shiny marker there.
  const top = 0;
  const bottom = Math.floor(meta.height * bottomRatio);
  if (bottom <= top) throw new Error("來源畫面尺寸不正確");
  const dir = path.join(dataDir, "frames", jobId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const frame = `${jobId}/${fileName}.jpg`;
  await sharp(source)
    .extract({ left: 0, top, width: meta.width, height: bottom - top })
    .resize({ width: 600, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toFile(path.join(dataDir, "frames", frame));
  await fs.chmod(path.join(dataDir, "frames", frame), 0o600);
  return frame;
}
