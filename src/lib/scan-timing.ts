import type { Scan, ScanItem } from "./iphone-types";

export type ScanTiming = {
  phase: "capture" | "analysis";
  averageMs: number | null;
  elapsedMs: number;
  remainingMs: number | null;
};

/** Use completed checkpoints; long gaps are pauses, not per-Pokémon work. */
export function scanTiming(scan: Scan, items: ScanItem[], clock = Date.now()): ScanTiming {
  // Two analysis checkpoints give the first interval; until then the capture
  // average is the only measurement.
  const analysisCheckpoints = items.filter((item) => item.analyzedAt).length;
  const phase = scan.phase === "analysis" && analysisCheckpoints >= 2
    ? "analysis"
    : "capture";
  const timestamps = items
    .filter((item) => phase === "capture" || item.analyzedAt)
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      position: item.position,
      time: Date.parse(phase === "capture" ? item.capturedAt : item.analyzedAt!),
    }));
  const intervals: number[] = [];
  for (let index = 1; index < timestamps.length; index++) {
    const delta = timestamps[index].time - timestamps[index - 1].time;
    if (timestamps[index].position === timestamps[index - 1].position + 1 &&
      Number.isFinite(delta) && delta > 0 && delta <= 60_000)
      intervals.push(delta);
  }
  const average = intervals.length
    ? Math.round(intervals.reduce((sum, ms) => sum + ms, 0) / intervals.length)
    : null;
  const recent = intervals.slice(-30);
  const recentAverage = recent.length >= 3
    ? recent.reduce((sum, ms) => sum + ms, 0) / recent.length
    : null;
  const done = phase === "capture" ? scan.scanned : scan.analyzed;
  const total = phase === "capture" ? scan.expected : scan.scanned;
  const lastCheckpoint = Math.max(0, ...timestamps.map((item) => item.time).filter(Number.isFinite));
  const end = scan.status === "completed"
    ? Date.parse(scan.completedAt || "") || lastCheckpoint || Date.parse(scan.updatedAt)
    : ["stopped", "failed"].includes(scan.status)
      ? Date.parse(scan.updatedAt)
      : clock;
  const start = Date.parse(scan.createdAt);
  return {
    phase,
    averageMs: average,
    elapsedMs: Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, end - start)
      : 0,
    remainingMs: scan.status === "running" && total !== null && recentAverage !== null
      ? Math.max(0, Math.round((total - done) * recentAverage))
      : null,
  };
}
