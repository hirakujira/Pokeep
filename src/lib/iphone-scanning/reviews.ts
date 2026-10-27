import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../runtime-config";
import { reevaluate } from "../evaluate";
import { dataDir, get, getSnapshot, now, put, transaction } from "../store";
import { scanItems, updateScan } from "../iphone-data";
import type { Pokemon } from "../types";
import type { Scan, ScanItem } from "../iphone-types";
import { specialStateFromMoves } from "../iphone-safety";
import { processPreparedInOrder } from "../ordered-prefetch";
import { reviewShiny } from "../shiny-review";
import { applySpecialVisualVerdict, reviewSpecialVisual } from "../special-visual-review";
import { analyzeOne, prepareAnalysis, recordAnalysisUsage } from "./analysis";

function pendingReviewCount(scanId: string) {
  return scanItems(scanId).filter((item) => {
    const record = item.pokemonId ? get<Pokemon>("pokemon", item.pokemonId) : null;
    return record && !record.verified;
  }).length;
}

export async function recheckFavoriteRecords(scanId: string) {
  const favorites = scanItems(scanId).filter((item) => {
    const record = item.pokemonId
      ? get<Pokemon>("pokemon", item.pokemonId)
      : null;
    return !item.favoriteRechecked && record?.fields.favorite === true && !record.verified;
  });
  if (!favorites.length) {
    updateScan(scanId, { review: pendingReviewCount(scanId) });
    return true;
  }
  let recheckedCount = 0;
  const rechecked = await processPreparedInOrder({
    items: favorites,
    needsPreparation: () => true,
    active: () => get<Scan>("scans", scanId)?.status === "running",
    prepare: async (item, signal) => {
      try {
        return await prepareAnalysis(scanId, item, signal);
      } catch {
        return null;
      }
    },
    consume: async (item, prepared) => {
      recheckedCount++;
      updateScan(scanId, {
        stage: `重新核對已標最愛 ${recheckedCount} / ${favorites.length} 隻`,
      });
      if (!prepared) return;
      try {
        await analyzeOne(scanId, item, Promise.resolve(prepared), true);
        if (get<Scan>("scans", scanId)?.status === "running")
          put("scan_items", item.id, { ...item, favoriteRechecked: true });
      } catch {
        // Keep this individual pending if its saved evidence cannot be rechecked.
      }
    },
    concurrency: getRuntimeConfig().analysisConcurrency,
  });
  if (!rechecked) return false;
  updateScan(scanId, { review: pendingReviewCount(scanId) });
  reevaluate();
  return true;
}

/** Apply saved two-frame ordinary appearance without re-running OCR or touching the phone. */
export function applyStoredNormalShadowReviews(scanId: string) {
  let changed = 0;
  for (const item of scanItems(scanId)) {
    if (item.specialReview?.verdict !== "normal" || !item.pokemonId || !item.fields)
      continue;
    transaction(() => {
      const record = get<Pokemon>("pokemon", item.pokemonId!);
      if (
        !record || record.jobId !== scanId || record.verified ||
        record.verification === "human" || record.candidates.length ||
        record.issues.length || Object.keys(record.overrides).length ||
        record.fields.shadow !== null || record.fields.purified !== null ||
        !isDeepStrictEqual(item.fields, record.fields)
      ) return;
      const fields = { ...record.fields };
      applySpecialVisualVerdict(fields, "normal", null);
      if (fields.shadow !== false || fields.purified !== null) return;
      put("pokemon", record.id, { ...record, fields, updatedAt: now() });
      put("scan_items", item.id, { ...item, fields });
      changed++;
    });
  }
  if (changed) reevaluate();
  return changed;
}

/** Copy a conclusive saved shiny verdict when it is the only field drift. */
export function applyStoredShinyReviews(scanId: string) {
  let changed = 0;
  for (const item of scanItems(scanId)) {
    const verdict = item.shinyReview?.verdict;
    if ((verdict !== "normal" && verdict !== "shiny") || !item.pokemonId || !item.fields)
      continue;
    transaction(() => {
      const record = get<Pokemon>("pokemon", item.pokemonId!);
      if (
        !record || record.jobId !== scanId || record.verified ||
        record.verification === "human" || record.candidates.length ||
        record.issues.length || Object.keys(record.overrides).length ||
        record.fields.shiny !== null
      ) return;
      const shiny = verdict === "shiny";
      if (item.fields!.shiny !== null && item.fields!.shiny !== shiny) return;
      if (!isDeepStrictEqual(
        { ...item.fields, shiny: record.fields.shiny }, record.fields,
      )) return;
      const fields = { ...record.fields, shiny };
      put("pokemon", record.id, { ...record, fields, updatedAt: now() });
      put("scan_items", item.id, { ...item, fields });
      changed++;
    });
  }
  if (changed) reevaluate();
  return changed;
}

/** Recheck visible special effects in two saved moments; never touch the phone. */
export async function reviewUnknownSpecialStates(scanId: string) {
  const candidates = scanItems(scanId).filter((item) => {
    if (item.specialReview || !item.pokemonId || !item.appraisalFrame) return false;
    const record = get<Pokemon>("pokemon", item.pokemonId);
    return Boolean(
      record && !record.verified && !record.candidates.length &&
      !record.issues.length && !Object.keys(record.overrides).length &&
      record.fields.costume === null &&
      specialStateFromMoves(record.fields).signal === null &&
      !specialStateFromMoves(record.fields).conflict &&
      record.fields.shadow === null && record.fields.purified === null,
    );
  });
  let processed = 0;
  const finished = await processPreparedInOrder({
    items: candidates,
    needsPreparation: () => true,
    active: () => get<Scan>("scans", scanId)?.status === "running",
    prepare: async (item, signal) => {
      try {
        return await reviewSpecialVisual(
          path.join(dataDir, "frames", item.frame),
          path.join(dataDir, "frames", item.appraisalFrame!),
          signal,
          (usage) => recordAnalysisUsage(scanId, usage),
        );
      } catch {
        return null;
      }
    },
    consume: async (item, result) => {
      processed++;
      updateScan(scanId, {
        stage: `比對已存畫面的暗影與淨化狀態 ${processed} / ${candidates.length} 隻`,
      });
      if (!result) return;
      const proof: NonNullable<ScanItem["specialReview"]> = {
        ...result,
        reviewedAt: now(),
      };
      if (proof.verdict === "shadow" || proof.verdict === "purified") {
        try {
          await analyzeOne(scanId, item, undefined, true, undefined, proof);
        } catch {
          // Keep the proof, but leave the record pending if other fields changed.
        }
      }
      const latest = get<ScanItem>("scan_items", item.id);
      if (latest) put("scan_items", item.id, { ...latest, specialReview: proof });
    },
    concurrency: 2,
  });
  applyStoredNormalShadowReviews(scanId);
  updateScan(scanId, { review: pendingReviewCount(scanId) });
  reevaluate();
  return finished;
}

/** Use two already saved moments and exact variant references; never touch the phone. */
export async function reviewUnknownShiny(scanId: string) {
  const snapshot = getSnapshot();
  if (!snapshot) return true;
  const candidates = scanItems(scanId).filter((item) => {
    if (item.shinyReview || !item.pokemonId || !item.appraisalFrame) return false;
    const record = get<Pokemon>("pokemon", item.pokemonId);
    const fields = record?.fields;
    return Boolean(
      record &&
      !record.verified &&
      !record.candidates.length &&
      !record.issues.length &&
      !Object.keys(record.overrides).length &&
      fields?.shiny === null &&
      fields.speciesId &&
      snapshot.species[fields.speciesId],
    );
  });
  let processed = 0;
  const finished = await processPreparedInOrder({
    items: candidates,
    needsPreparation: () => true,
    active: () => get<Scan>("scans", scanId)?.status === "running",
    prepare: async (item, signal) => {
      const record = get<Pokemon>("pokemon", item.pokemonId!);
      const species = record?.fields.speciesId && snapshot.species[record.fields.speciesId];
      if (!species || !item.appraisalFrame) return null;
      try {
        return await reviewShiny(
          species,
          record?.fields.form ?? null,
          path.join(dataDir, "frames", item.frame),
          path.join(dataDir, "frames", item.appraisalFrame),
          signal,
          (usage) => recordAnalysisUsage(scanId, usage),
        );
      } catch {
        return null;
      }
    },
    consume: async (item, result) => {
      processed++;
      updateScan(scanId, {
        stage: `比對已存畫面的色違狀態 ${processed} / ${candidates.length} 隻`,
      });
      if (!result) return;
      const proof: NonNullable<ScanItem["shinyReview"]> = {
        ...result,
        reviewedAt: now(),
      };
      if (proof.verdict !== "uncertain") {
        try {
          await analyzeOne(scanId, item, undefined, true, proof);
        } catch {
          return;
        }
      }
      const latest = get<ScanItem>("scan_items", item.id);
      if (latest) put("scan_items", item.id, { ...latest, shinyReview: proof });
    },
    concurrency: getRuntimeConfig().shinyReviewConcurrency,
  });
  applyStoredShinyReviews(scanId);
  applyStoredNormalShadowReviews(scanId);
  updateScan(scanId, { review: pendingReviewCount(scanId) });
  reevaluate();
  return finished;
}
