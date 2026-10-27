import type { IphoneMcp } from "../iphone-mcp";
import { iphoneUseVersion } from "../iphone-mcp";
import { getRuntimeConfig } from "../runtime-config";
import { reevaluate } from "../evaluate";
import { get, now } from "../store";
import { scanItems, updateScan } from "../iphone-data";
import type { PhonePage } from "../iphone-vision";
import type { Scan } from "../iphone-types";
import { processGrowingInOrder, processPreparedInOrder } from "../ordered-prefetch";
import {
  classify,
  ensureReady,
  identifyGame,
  type PhoneObservation,
} from "./phone";
import { swipeScan, tapInitialTarget } from "./gestures";
import { captureOne } from "./capture";
import { analyzeOne, prepareAnalysis } from "./analysis";
import {
  recheckFavoriteRecords,
  reviewUnknownShiny,
  reviewUnknownSpecialStates,
} from "./reviews";

export async function analyzeScan(scanId: string) {
  const items = scanItems(scanId);
  const initial = get<Scan>("scans", scanId)!;
  if (initial.expected !== null && items.length !== initial.expected)
    throw new Error("截圖數量與盒子總數不符，不能開始解析");
  if (items.length !== initial.scanned)
    throw new Error("逐隻截圖檢查點不完整，不能開始解析");
  const analyzed = items.filter((item) => item.pokemonId).length;
  if (initial.analyzed !== analyzed) updateScan(scanId, { analyzed });
  if (!(await recheckFavoriteRecords(scanId))) return;
  const finished = await processPreparedInOrder({
    items,
    needsPreparation: (item) => !item.pokemonId,
    active: () => get<Scan>("scans", scanId)?.status === "running",
    prepare: (item, signal) => prepareAnalysis(scanId, item, signal),
    consume: async (item, result) => analyzeOne(scanId, item, Promise.resolve(result)),
    concurrency: getRuntimeConfig().analysisConcurrency,
  });
  reevaluate();
  if (!finished) return;
  if (!(await recheckFavoriteRecords(scanId))) return;
  if (!(await reviewUnknownSpecialStates(scanId))) return;
  if (!(await reviewUnknownShiny(scanId))) return;
  if (get<Scan>("scans", scanId)?.status === "running")
    updateScan(scanId, {
      status: "completed",
      completedAt: now(),
      analyzed: items.length,
      stage: "截圖與解析完成，請檢查放生候選",
      error: null,
    });
}

async function clearSearchAndFilters(
  phone: IphoneMcp,
  current: PhoneObservation,
  page: PhonePage,
) {
  if (page.searchActive) {
    current = await tapInitialTarget(phone, current, "clear_search");
    page = await classify(current);
  }
  if (page.filterActive) {
    current = await tapInitialTarget(phone, current, "clear_filters");
    page = await classify(current);
  }
  if (page.searchActive !== false || page.filterActive !== false)
    throw new Error("無法確認整個盒子的搜尋和篩選已清除");
  return { current, page };
}

async function openFirstPokemon(phone: IphoneMcp, scan: Scan) {
  let current = await identifyGame(phone, await ensureReady(phone));
  let page = scan.scanned === 0 ? await classify(current) : null;
  if (scan.scanned === 0 && page?.page !== "collection")
    throw new Error("開始掃描前請在 Pokémon GO 開啟寶可夢盒子列表");
  if (page?.page === "collection") {
    if (scan.scope === "all")
      ({ current, page } = await clearSearchAndFilters(phone, current, page));
    scan = updateScan(scan.id, {
      expected: page.visibleCount,
      sort: page.sort,
      stage: "開始逐隻截圖",
    });
    current = await tapInitialTarget(phone, current, "first_pokemon");
  }
  return { scan, current };
}

function backgroundAnalysis(scanId: string) {
  const stop = new AbortController();
  let pipeline: Promise<void> | null = null;
  let error: string | null = null;
  return {
    start(scanned: number) {
      if (pipeline || scanned < 20) return;
      pipeline = processGrowingInOrder({
        list: () => scanItems(scanId),
        startAfter: 20,
        needsPreparation: (item) => !item.pokemonId,
        active: () => get<Scan>("scans", scanId)?.status === "running",
        signal: stop.signal,
        prepare: (item, signal) => prepareAnalysis(scanId, item, signal),
        consume: (item, result) => analyzeOne(scanId, item, Promise.resolve(result)),
        // Phone capture has priority; use fewer AI requests until it finishes.
        concurrency: Math.min(2, getRuntimeConfig().analysisConcurrency),
      }).catch((caught) => {
        error = caught instanceof Error ? caught.message : "背景解析失敗";
      });
    },
    stop() {
      stop.abort();
      return pipeline;
    },
    error: () => error,
  };
}

/** Returns the latest scan when capture finished, or null when it stopped or paused. */
async function captureRemaining(
  phone: IphoneMcp,
  scan: Scan,
  current: PhoneObservation,
  analysis: ReturnType<typeof backgroundAnalysis>,
) {
  while (true) {
    scan = get<Scan>("scans", scan.id)!;
    if (scan.status !== "running") return null;
    if (scan.expected !== null && scan.scanned >= scan.expected) return scan;
    if (
      scan.expected === null &&
      scan.scanned > 0 &&
      scan.scanned % 100 === 0
    ) {
      updateScan(scan.id, {
        status: "paused",
        stage: `已截圖 ${scan.scanned} 隻；請確認範圍後繼續`,
        checkpointRequired: true,
      });
      return null;
    }
    current = await captureOne(phone, scan, current);
    scan = get<Scan>("scans", scan.id)!;
    analysis.start(scan.scanned);
    if (scan.expected !== null && scan.scanned >= scan.expected) return scan;
    current = await swipeScan(phone, current, "left");
  }
}

export async function runScan(phone: IphoneMcp, initial: Scan) {
  const scan = updateScan(initial.id, {
    status: "running",
    stage: initial.phase === "analysis" ? "繼續解析已保存畫面" : "檢查 iPhone",
    iphoneUseVersion:
      initial.phase === "analysis"
        ? initial.iphoneUseVersion
        : iphoneUseVersion(),
  });
  if (scan.phase === "analysis") {
    await analyzeScan(scan.id);
    return;
  }
  if (
    scan.expected !== null &&
    scan.scanned >= scan.expected &&
    scanItems(scan.id).length === scan.scanned
  ) {
    updateScan(scan.id, {
      phase: "analysis",
      stage: "截圖完成，開始解析",
      error: null,
    });
    await analyzeScan(scan.id);
    return;
  }
  const opened = await openFirstPokemon(phone, scan);
  const analysis = backgroundAnalysis(scan.id);
  analysis.start(opened.scan.scanned);
  let captured: Scan | null;
  try {
    captured = await captureRemaining(phone, opened.scan, opened.current, analysis);
  } finally {
    await analysis.stop();
  }
  if (!captured) return;
  updateScan(captured.id, {
    phase: "analysis",
    stage: analysis.error()
      ? "截圖完成，重試先前失敗的解析"
      : "截圖完成，解析剩餘畫面",
  });
  await analyzeScan(captured.id);
}
