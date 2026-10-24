import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import { dataDir } from "./store";

export const ffmpeg = () => process.env.FFMPEG_PATH || ffmpegPath || "ffmpeg";
export function runMedia(
  args: string[],
  signal?: AbortSignal,
  allowFailure = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ ffmpeg(), args, {
      signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr = (stderr + b.toString()).slice(-32000);
    });
    child.once("error", (error) =>
      reject(
        new Error(
          error.name === "AbortError"
            ? "分析已取消"
            : `無法啟動 FFmpeg：${error.message}`,
        ),
      ),
    );
    child.once("close", (code) =>
      code === 0 || allowFailure
        ? resolve(stderr)
        : reject(new Error(`影片處理失敗：${stderr.slice(-700)}`)),
    );
  });
}
export async function probeVideo(file: string, signal?: AbortSignal) {
  // Use the native FFmpeg executable: some ffprobe-static releases ship an x64 binary under their arm64 path.
  const text = await runMedia(["-hide_banner", "-i", file], signal, true);
  const duration = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/),
    video = text.split("\n").find((l) => l.includes("Video:")),
    dimensions = video?.match(/\b(\d{2,5})x(\d{2,5})\b/);
  if (!duration || !dimensions)
    throw new Error("影片無法解碼或沒有可讀取的影像軌");
  const seconds =
    Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  if (seconds <= 0 || seconds > 600)
    throw new Error("每段影片必須介於 0～10 分鐘");
  let width = Number(dimensions[1]),
    height = Number(dimensions[2]);
  if (/rotation of (?:-?90|-?270)/.test(text))
    [width, height] = [height, width];
  if (width < 200 || height < 400 || width > 8192 || height > 8192)
    throw new Error("影片解析度不支援，請使用清晰的手機螢幕錄影");
  return { duration: seconds, width, height };
}
export type IvMeasurement = {
  values: number[];
  rows: number[];
  left: number;
  right: number;
  confidence: number;
};
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
  for (let y = Math.floor(h * 0.56); y < Math.floor(h * 0.89); y++) {
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
type Fingerprint = {
  upper: number[];
  center: number[];
  iv: number[] | null;
  ivInfo: IvMeasurement | null;
};
async function fingerprint(file: string): Promise<Fingerprint> {
  const meta = await sharp(file).metadata(),
    w = meta.width!,
    h = meta.height!;
  const roi = async (
    left: number,
    top: number,
    width: number,
    height: number,
    threshold: number,
  ) =>
    Array.from(
      await sharp(file)
        .extract({
          left: Math.floor(w * left),
          top: Math.floor(h * top),
          width: Math.floor(w * width),
          height: Math.floor(h * height),
        })
        .resize(80, 16)
        .greyscale()
        .threshold(threshold)
        .raw()
        .toBuffer(),
    );
  const ivInfo = await measureIV(file);
  const rgb = await sharp(file).removeAlpha().raw().toBuffer();
  const hpRows: number[][] = [];
  for (let y = Math.floor(h * 0.15); y < h * 0.57; y++) {
    let green = 0;
    for (let x = Math.floor(w * 0.27); x < w * 0.73; x++) {
      const k = (y * w + x) * 3,
        r = rgb[k],
        g = rgb[k + 1],
        b = rgb[k + 2];
      if (g > 150 && g > r * 1.22 && g > b * 1.09 && r > 55) green++;
    }
    if (green > w * 0.38) {
      const prev = hpRows.at(-1);
      if (prev && y - prev.at(-1)! < 2) prev.push(y);
      else hpRows.push([y]);
    }
  }
  // Anchor the name to the HP bar, so scrolling the details panel does not hide the identity region.
  const hp = hpRows.find((rows) => rows.length >= 2 && rows.length <= 9)?.[0];
  const nameTop = hp ? Math.max(0.06, hp / h - 0.052) : 0.405;
  return {
    upper: await roi(0.25, 0.056, 0.36, 0.032, 235),
    center: await roi(0.24, nameTop, 0.45, 0.039, 145),
    iv: ivInfo?.values || null,
    ivInfo,
  };
}
function distance(a: number[], b: number[]) {
  return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
}
export type SelectedFrame = {
  frame: string;
  time: number;
  segment: string;
  iv: number[] | null;
  issues: string[];
};
export async function extractFrames(
  file: string,
  jobId: string,
  videoId: string,
  signal?: AbortSignal,
  onProgress?: (p: number) => void,
): Promise<SelectedFrame[]> {
  const rawDir = path.join(dataDir, "tmp", `${jobId}-${videoId}`),
    outDir = path.join(dataDir, "frames", jobId);
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  try {
    await runMedia(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "2",
        "-i",
        file,
        "-vf",
        "fps=4,scale=600:-2",
        "-q:v",
        "3",
        "-threads",
        "2",
        path.join(rawDir, "%06d.jpg"),
      ],
      signal,
    );
    const files = (await fs.readdir(rawDir))
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    if (!files.length) throw new Error("未能擷取任何影片畫面");
    const groups: { file: string; time: number; fp: Fingerprint }[][] = [];
    let previous: Fingerprint | null = null;
    for (let i = 0; i < files.length; i++) {
      signal?.throwIfAborted();
      const current = await fingerprint(path.join(rawDir, files[i]));
      const sameIV =
        current.iv &&
        previous?.iv &&
        current.iv.every((v, j) => v === previous!.iv![j]);
      const changed =
        !previous ||
        (sameIV
          ? distance(previous.center, current.center) > 25 ||
            distance(previous.upper, current.upper) > 36
          : distance(previous.upper, current.upper) > 28 ||
            distance(previous.center, current.center) > 21 ||
            Boolean(previous.iv) !== Boolean(current.iv) ||
            (current.iv &&
              previous.iv &&
              current.iv.some((v, j) => v !== previous!.iv![j])));
      if (changed || !groups.length) groups.push([]);
      groups.at(-1)!.push({ file: files[i], time: i / 4, fp: current });
      previous = current;
      onProgress?.((i + 1) / files.length);
    }
    const selected: SelectedFrame[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      // Keep short appearances too; they become review items rather than disappearing.
      const picks =
        group.length >= 5
          ? [
              group[Math.floor(group.length * 0.35)],
              group[Math.floor(group.length * 0.8)],
            ]
          : [group[Math.floor(group.length / 2)]];
      // Cap gaps within a segment. A stable-looking region must never erase a briefly visible different Pokemon.
      if (group.length > 6)
        for (let j = 0; j < group.length; j += 6)
          if (!picks.some((p) => Math.abs(p.time - group[j].time) < 0.6))
            picks.push(group[j]);
      picks.sort((a, b) => a.time - b.time);
      for (let j = 0; j < picks.length; j++) {
        const pick = picks[j],
          source = path.join(rawDir, pick.file),
          meta = await sharp(source).metadata(),
          w = meta.width!,
          h = meta.height!;
        const fileName = `${videoId}-${String(i).padStart(4, "0")}-${j}.jpg`;
        // Crop out status bar and the capture-date/location panel in the supported iPhone layout.
        const bottom = pick.fp.ivInfo
          ? Math.min(h * 0.88, pick.fp.ivInfo.rows[2] + h * 0.035)
          : h * 0.92;
        const top = Math.floor(h * 0.055);
        await sharp(source)
          .extract({ left: 0, top, width: w, height: Math.floor(bottom) - top })
          .jpeg({ quality: 90 })
          .toFile(path.join(outDir, fileName));
        selected.push({
          frame: `${jobId}/${fileName}`,
          time: pick.time,
          segment: `${videoId}-${i}`,
          iv: pick.fp.iv,
          issues:
            group.length < 2
              ? ["此畫面停留不足 0.5 秒，請核對是否為切換動畫"]
              : [],
        });
      }
    }
    return selected;
  } finally {
    await fs.rm(rawDir, { recursive: true, force: true });
  }
}
