import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { referenceManifest } from "../tests/fixtures";
import {
  emptyFields,
  type Job,
  type Pokemon,
  type Fields,
} from "../src/lib/types";
import {
  dataDir,
  get,
  getSnapshot,
  id,
  now,
  put,
  transaction,
} from "../src/lib/store";
import {
  runMedia,
  measureIV,
  probeVideo,
  extractFrames,
} from "../src/lib/video";
import { inferLevels, reevaluate } from "../src/lib/evaluate";

// These labels were manually read from the user's supplied reference recordings.
// This script validates the numeric pipeline; it does not claim to run OpenAI recognition.
const details: Record<string, Partial<Fields>> = {
  caterpie: {
    fastMove: "TACKLE",
    chargeMove: "STRUGGLE",
    powerUpDust: 1900,
    powerUpCandy: 2,
    evolutionCandy: 12,
    candy: 191,
    xlCandy: 4,
  },
  dewpider: {
    fastMove: "BUG_BITE",
    chargeMove: "MIRROR_COAT",
    powerUpDust: 1300,
    powerUpCandy: 2,
    evolutionCandy: 50,
    candy: 3,
    secondMoveDust: 50000,
    secondMoveCandy: 50,
  },
  lechonk: {
    fastMove: "TACKLE",
    chargeMove: "TRAILBLAZE",
    powerUpDust: 2200,
    powerUpCandy: 2,
    evolutionCandy: 50,
    candy: 9,
    secondMoveDust: 10000,
    secondMoveCandy: 25,
  },
  grimer_alolan_shadow: {
    fastMove: "POISON_JAB",
    chargeMove: "FRUSTRATION",
    powerUpDust: 961,
    powerUpCandy: 2,
    evolutionCandy: 50,
    candy: 84,
    xlCandy: 1,
    purificationDust: 3000,
    purificationCandy: 3,
    secondMoveDust: 60000,
    secondMoveCandy: 60,
  },
  mareanie: {
    fastMove: "BITE",
    chargeMove: "GUNK_SHOT",
    powerUpDust: 400,
    powerUpCandy: 1,
    evolutionCandy: 50,
    candy: 6,
    secondMoveDust: 50000,
    secondMoveCandy: 50,
  },
  honedge: {
    fastMove: "PSYCHO_CUT",
    chargeMove: "IRON_HEAD",
    powerUpDust: 2500,
    powerUpCandy: 2,
    evolutionCandy: 25,
    candy: 80,
    xlCandy: 8,
  },
  sobble: {
    fastMove: "WATER_GUN",
    chargeMove: "SURF",
    powerUpDust: 2500,
    powerUpCandy: 2,
    evolutionCandy: 25,
    candy: 31,
    xlCandy: 2,
  },
  cacnea: {
    fastMove: "SAND_ATTACK",
    chargeMove: "SEED_BOMB",
    powerUpDust: 1900,
    powerUpCandy: 2,
    evolutionCandy: 50,
    candy: 53,
    xlCandy: 4,
    secondMoveDust: 50000,
    secondMoveCandy: 50,
  },
  dwebble: {
    fastMove: "CUT",
    chargeMove: "ROCK_BLAST",
    powerUpDust: 1600,
    powerUpCandy: 2,
    evolutionCandy: 50,
    candy: 74,
    secondMoveDust: 10000,
    secondMoveCandy: 25,
  },
  snivy: {
    fastMove: "VINE_WHIP",
    chargeMove: "WRAP",
    powerUpDust: 2500,
    powerUpCandy: 2,
    evolutionCandy: 25,
    candy: 72,
    xlCandy: 7,
    secondMoveDust: 10000,
    secondMoveCandy: 25,
  },
  tadbulb: {
    fastMove: "WATER_GUN",
    chargeMove: "DISCHARGE",
    powerUpDust: 4000,
    powerUpCandy: 4,
    evolutionCandy: 50,
    candy: 7,
    xlCandy: 2,
  },
};
async function main() {
  const [appraisal, ability] = process.argv
      .slice(2)
      .filter((x) => !x.startsWith("--")),
    shouldImport = process.argv.includes("--import");
  if (!appraisal || !ability)
    throw new Error(
      "用法：npm run references:validate -- 評價影片.MP4 招式影片.MP4 [--import]",
    );
  const snapshot = getSnapshot();
  if (!snapshot) throw new Error("請先執行 npm run data:update");
  const meta = [await probeVideo(appraisal), await probeVideo(ability)];
  const jobId = "reference-recordings-v1",
    directory = path.join(dataDir, "frames", jobId),
    temp = path.join(dataDir, "tmp", "reference-validation");
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(temp, { recursive: true });
  const rows: Pokemon[] = [],
    report: unknown[] = [];
  try {
    const selectedAppraisals = await extractFrames(
      appraisal,
      "reference-pipeline",
      "appraisal",
    );
    const selectedDetails = await extractFrames(
      ability,
      "reference-pipeline",
      "details",
    );
    for (const entry of referenceManifest) {
      assert.ok(
        selectedAppraisals.some(
          (frame) =>
            frame.iv?.join("/") === entry.iv.join("/") &&
            Math.abs(frame.time - entry.appraisal) <= 1,
        ),
        `${entry.name} 必須存在於實際抽幀結果`,
      );
      assert.ok(
        selectedDetails.some(
          (frame) => Math.abs(frame.time - entry.details) <= 0.75,
        ),
        `${entry.name} 能力頁的出現時段必須保留畫面`,
      );
      const f: Fields = {
        ...emptyFields(),
        name: entry.name,
        speciesId: entry.id,
        form: entry.id.includes("alolan") ? "alolan" : "normal",
        cp: entry.cp,
        hp: entry.hp,
        ivAtk: entry.iv[0],
        ivDef: entry.iv[1],
        ivSta: entry.iv[2],
        gender: entry.gender,
        height: entry.height,
        weight: entry.weight,
        shadow: entry.id.endsWith("_shadow"),
        purified: false,
        shiny: false,
        favorite: false,
        stardust: 1788643,
        ...details[entry.id],
      };
      const levels = inferLevels(snapshot.species[entry.id], f, snapshot);
      assert.deepEqual(levels, [entry.level]);
      const sources: Pokemon["sources"] = [];
      for (const [index, file] of [appraisal, ability].entries()) {
        const time = index === 0 ? entry.appraisal : entry.details,
          raw = path.join(temp, `${entry.id}-${index}.jpg`),
          fileName = `${entry.id}-${index}.jpg`;
        await runMedia([
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          String(time),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          "scale=600:-2",
          "-y",
          raw,
        ]);
        const measured = await measureIV(raw);
        if (index === 0)
          assert.deepEqual(
            measured?.values,
            [...entry.iv],
            `${entry.name} 評價條量測`,
          );
        const imageMeta = await sharp(raw).metadata(),
          h = imageMeta.height!,
          top = Math.floor(h * 0.055),
          bottom =
            index === 0
              ? Math.min(h * 0.88, measured!.rows[2] + h * 0.035)
              : h * 0.92;
        await sharp(raw)
          .extract({
            left: 0,
            top,
            width: imageMeta.width!,
            height: Math.floor(bottom) - top,
          })
          .jpeg({ quality: 90 })
          .toFile(path.join(directory, fileName));
        const keys = (
          index === 0
            ? [
                "name",
                "speciesId",
                "form",
                "cp",
                "hp",
                "gender",
                "height",
                "weight",
                "ivAtk",
                "ivDef",
                "ivSta",
                "shadow",
                "purified",
                "shiny",
                "favorite",
              ]
            : Object.keys(details[entry.id])
        ) as (keyof Fields)[];
        sources.push({
          observationId: `${jobId}-${entry.id}-${index}`,
          frame: `${jobId}/${fileName}`,
          time,
          video: path.basename(file),
          fields: keys,
        });
      }
      rows.push({
        id: `reference-${entry.id}`,
        jobId,
        fields: f,
        overrides: {},
        sources,
        issues: [
          "此資料由提供的參考影片人工整理，尚未使用 OpenAI API 辨識；請核對來源後儲存。",
        ],
        candidates: [],
        verified: false,
        locked: false,
        owned: true,
        createdAt: now(),
        updatedAt: now(),
        analysis: null,
      });
      report.push({
        species: entry.id,
        name: entry.name,
        cp: entry.cp,
        iv: entry.iv,
        level: levels[0],
        appraisal: entry.appraisal,
        details: entry.details,
        ivMeasurement: "passed",
        identity: "manually-labelled",
      });
    }
    const output = {
      validatedAt: now(),
      mode: "manual-reference-labels-not-live-AI",
      snapshot: snapshot.version,
      videos: meta,
      pipeline: {
        appraisalFrames: selectedAppraisals.length,
        detailFrames: selectedDetails.length,
        appraisalIndividualsCovered: 11,
        detailTimeWindowsCovered: 11,
      },
      individuals: report,
    };
    await fs.writeFile(
      path.join(dataDir, "reference-validation.json"),
      JSON.stringify(output, null, 2),
    );
    if (shouldImport && !get("jobs", jobId)) {
      const job: Job = {
        id: jobId,
        name: "參考錄影 · 人工整理（非 AI 辨識）",
        status: "review",
        stage: "11 隻個體已人工整理，等待你核對",
        progress: 100,
        files: [appraisal, ability].map((file, i) => ({
          id: id(),
          name: path.basename(file),
          path: "",
          size: 0,
          ...meta[i],
        })),
        error: null,
        createdAt: now(),
        updatedAt: now(),
        usage: { input: 0, output: 0, requests: 0, cached: 0 },
        notices: ["參考驗收使用人工標註，並未呼叫 OpenAI API。"],
        attempts: 1,
      };
      transaction(() => {
        put("jobs", jobId, job);
        for (const p of rows) put("pokemon", p.id, p);
      });
      reevaluate();
    }
    console.log(
      JSON.stringify(
        {
          validated: rows.length,
          ivMeasurements: 11,
          cpHpLevelChecks: 11,
          imported: shouldImport,
          report: path.join(dataDir, "reference-validation.json"),
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
