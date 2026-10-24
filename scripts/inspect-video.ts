import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import { extractFrames, probeVideo } from "../src/lib/video";
import { dataDir } from "../src/lib/store";

async function main() {
  const file = process.argv[2];
  if (!file)
    throw new Error("用法：npm run video:inspect -- /absolute/path/video.MP4");
  const videoId = path.basename(file).includes("03-03-18")
    ? "reference-appraisal"
    : "reference-details";
  const jobId = "reference-inspection";
  console.log(await probeVideo(file));
  const frames = await extractFrames(file, jobId, videoId);
  const out = path.join(dataDir, "inspection");
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(
    path.join(out, `${videoId}.json`),
    JSON.stringify(frames, null, 2),
  );
  const w = 200,
    h = 455,
    cols = 6;
  for (let start = 0; start < frames.length; start += 30) {
    const slice = frames.slice(start, start + 30),
      layers = [];
    for (let i = 0; i < slice.length; i++) {
      const f = slice[i],
        thumb = await sharp(path.join(dataDir, "frames", f.frame))
          .resize(w, h - 30, { fit: "contain", background: "#eeeeee" })
          .toBuffer();
      const label = Buffer.from(
        `<svg width="200" height="30"><rect width="200" height="30" fill="white"/><text x="6" y="20" font-size="14">${f.time}s · ${f.iv?.join("/") || "detail"}</text></svg>`,
      );
      layers.push(
        { input: thumb, left: (i % cols) * w, top: Math.floor(i / cols) * h },
        {
          input: label,
          left: (i % cols) * w,
          top: Math.floor(i / cols) * h + h - 30,
        },
      );
    }
    const target = path.join(out, `${videoId}-${start}.jpg`);
    await sharp({
      create: {
        width: w * cols,
        height: h * Math.ceil(slice.length / cols),
        channels: 3,
        background: "#eeeeee",
      },
    })
      .composite(layers)
      .jpeg()
      .toFile(target);
    console.log(target);
  }
  console.log(
    `selected=${frames.length}, segments=${new Set(frames.map((f) => f.segment)).size}`,
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
