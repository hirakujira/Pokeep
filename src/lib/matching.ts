import {
  effective,
  type Fields,
  type Observation,
  type Pokemon,
} from "./types";
import { id, now, put } from "./store";

const identityKeys = [
  "cp",
  "hp",
  "gender",
  "height",
  "weight",
  "shadow",
  "purified",
  "shiny",
  "costume",
] as const;
export function matching(
  a: Fields,
  b: Fields,
): "exact" | "possible" | "different" {
  if (!a.speciesId || !b.speciesId || a.speciesId !== b.speciesId)
    return "different";
  if (a.form !== null && b.form !== null && a.form !== b.form)
    return "different";
  let strong = 0;
  for (const key of identityKeys) {
    if (a[key] !== null && b[key] !== null) {
      if (a[key] !== b[key]) return "different";
      if (["cp", "hp", "gender", "height", "weight"].includes(key)) strong++;
    }
  }
  for (const key of ["ivAtk", "ivDef", "ivSta"] as const)
    if (a[key] !== null && b[key] !== null && a[key] !== b[key])
      return "different";
  return strong === 5 ? "exact" : "possible";
}
export function mergeObservation(p: Pokemon, o: Observation): Pokemon {
  const fields = { ...p.fields };
  const issues = [...p.issues, ...o.issues];
  for (const key of Object.keys(fields) as (keyof Fields)[]) {
    if (
      o.fields[key] !== null &&
      fields[key] !== null &&
      o.fields[key] !== fields[key]
    )
      issues.push(`欄位衝突：${key}，請核對來源畫面`);
    if (fields[key] === null)
      (fields as Record<string, unknown>)[key] = o.fields[key];
  }
  return {
    ...p,
    fields,
    issues: [...new Set(issues)],
    verified: issues.length ? false : p.verified,
    verification: issues.length ? null : p.verification,
    sources: [
      ...p.sources,
      {
        observationId: o.id,
        frame: o.frame,
        time: o.time,
        video: o.video,
        fields: (Object.keys(o.fields) as (keyof Fields)[]).filter(
          (k) => o.fields[k] !== null,
        ),
        source: o.source || "video",
        capturedAt: o.capturedAt,
        scanItemId: o.scanItemId,
      },
    ],
    updatedAt: now(),
  };
}
export function integrateObservations(
  observations: Observation[],
  existing: Pokemon[],
): Pokemon[] {
  const result = existing.map((p) => ({ ...p }));
  const segments = new Map<string, Pokemon>();
  const lastByVideo = new Map<string, { id: string; time: number }>();
  for (const o of observations) {
    // Only consecutive frames in the same detected segment are intrinsically one observation group.
    const segmentKey = `${o.jobId}/${o.video}/${o.segment}`;
    const current = segments.get(segmentKey);
    if (
      current &&
      (matching(effective(current), o.fields) !== "different" ||
        !current.fields.speciesId ||
        !o.fields.speciesId)
    ) {
      const next = mergeObservation(
        result.find((p) => p.id === current.id)!,
        o,
      );
      result[result.findIndex((p) => p.id === current.id)] = next;
      segments.set(segmentKey, next);
      lastByVideo.set(o.video, { id: next.id, time: o.time });
      continue;
    }
    const possible = result.filter(
      (p) => p.owned && matching(effective(p), o.fields) !== "different",
    );
    const exact = possible.filter(
      (p) => matching(effective(p), o.fields) === "exact",
    );
    // Identical observations within a continuous appearance can enrich the same record;
    // a later reappearance in the same video still requires review.
    const last = lastByVideo.get(o.video);
    const sameContinuousAppearance = Boolean(
      last && exact[0] && last.id === exact[0].id && o.time - last.time <= 3,
    );
    const safe =
      exact.length === 1 &&
      (!exact[0].sources.some(
        (s) => s.video === o.video && s.frame.startsWith(`${o.jobId}/`),
      ) ||
        sameContinuousAppearance);
    if (safe) {
      const next = mergeObservation(exact[0], o);
      result[result.findIndex((p) => p.id === next.id)] = next;
      segments.set(segmentKey, next);
      lastByVideo.set(o.video, { id: next.id, time: o.time });
    } else {
      let p: Pokemon = {
        id: id(),
        jobId: o.jobId,
        fields: o.fields,
        overrides: {},
        sources: [],
        issues: o.issues,
        candidates: possible.map((x) => x.id),
        verified: false,
        verification: null,
        locked: false,
        owned: true,
        createdAt: now(),
        updatedAt: now(),
        analysis: null,
      };
      p = mergeObservation(p, {
        ...o,
        issues: possible.length
          ? [...o.issues, "疑似重複個體，請確認是否合併"]
          : o.issues,
      });
      result.push(p);
      segments.set(segmentKey, p);
      lastByVideo.set(o.video, { id: p.id, time: o.time });
      for (const candidate of possible) {
        candidate.candidates = [...new Set([...candidate.candidates, p.id])];
        candidate.issues = [
          ...new Set([...candidate.issues, "疑似重複個體，請確認是否合併"]),
        ];
        candidate.verified = false;
      }
    }
  }
  return result;
}
export function savePokemon(p: Pokemon) {
  put("pokemon", p.id, p);
}
