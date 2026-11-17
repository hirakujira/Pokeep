import type { PhoneConnection } from "./phone-connection";
import {
  ensureReady,
  observe,
  saveCapture,
} from "./iphone-scan";
import { assertBatchFresh } from "./iphone-data";
import {
  transferExclusion,
  transferSignature,
} from "./iphone-safety";
import { effective, type Pokemon, type Snapshot } from "./types";
import { get, getSettings, getSnapshot, listPokemon, now, put, transaction } from "./store";
import { completeBoxIds, reevaluate } from "./evaluate";
import type { TransferBatch, TransferEntry } from "./iphone-types";
import {
  defaultTransferSearchFilters,
  transferSearchQuery,
  type TransferSearchFilter,
} from "./transfer-search-filters";
import { readLocalOcr, type OcrLine } from "./local-ocr";
import {
  assertUniqueDexCp,
  collectionSearchState,
  cpCandidates,
  detailCp,
  dialogCancelPoint,
  dialogText,
  pokemonMenuOpen,
  searchResultCount,
  standardTransferDialog,
} from "./iphone-transfer-search";

type Screen = Awaited<ReturnType<typeof observe>>;
type Wait = (milliseconds: number) => Promise<void>;

const sleep: Wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const ocr = async (file: string) => (await readLocalOcr([file]))[0];

class SkippedCandidate extends Error {
  /** Dex whose search results are still on screen after the skip. */
  readonly shownDex: number | null;
  constructor(message: string, shownDex: number | null = null) {
    super(message);
    this.shownDex = shownDex;
  }
}

// Supported portrait layout, calibrated on Gjallarhorn. The final tap is
// always preceded by a durable sent journal entry; the screen is read after it.
const transferPoint = {
  search: { x: 0.5, y: 0.177 },
  backToBox: { x: 0.095, y: 0.177 },
  confirmSearch: { x: 0.752, y: 0.588 },
  favorite: { x: 0.9, y: 0.077 },
  // The open menu's X takes the place of its button.
  menu: { x: 0.865, y: 0.94 },
  transfer: { x: 0.74, y: 0.854 },
  confirm: { x: 0.5, y: 0.534 },
  closeDetail: { x: 0.5, y: 0.94 },
} as const;
// YES is tapped without reading the prompt. On Gungnir the prompt is drawn
// about 150 ms after 傳送 and takes a tap by 350 ms; a lost YES leaves the
// prompt up, which settleAfterConfirm reports for NO.
const CONFIRM_DELAY_MS = 700;
// Dialogs, the menu and the detail page finish closing within about 300 ms.
// Reading sooner can show the old screen and repeat a tap on the new one.
const CLOSE_SETTLE_MS = 700;

async function tapFast(
  phone: PhoneConnection,
  observation: Screen,
  point: { x: number; y: number },
) {
  if (!observation.image) throw new Error("沒有可用於點擊的手機截圖尺寸");
  await phone.call("tap", {
    x: point.x * observation.image.width * observation.image.pixel_to_point[0],
    y: point.y * observation.image.height * observation.image.pixel_to_point[1],
    observation_id: observation.observation_id,
    observe: "none",
  });
}

export async function observeGameForeground(
  phone: PhoneConnection,
  first: Screen,
  wait: Wait = sleep,
) {
  let current = first;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (current.app === "com.nianticlabs.pokemongo") return current;
    if (attempt < 5) {
      await wait(1_500);
      current = await observe(phone);
    }
  }
  throw new Error("Pokémon GO 暫時不是前景 App；已暫停放生，請回到寶可夢盒");
}

/** Leaves the search for the whole box with "<". */
export async function leaveSearch(
  phone: PhoneConnection,
  screen: Screen,
  wait: Wait = sleep,
) {
  try {
    await tapFast(phone, screen, transferPoint.backToBox);
  } catch (error) {
    const failure = error as Error & { code?: string; uncertain?: boolean };
    if (failure.code !== "stale_observation" || failure.uncertain !== false)
      throw error;
    // The old-screen tap was explicitly rejected before execution. Wait
    // through a notification, then retry this navigation tap from a new frame.
    const fresh = await observeGameForeground(phone, await observe(phone), wait);
    await tapFast(phone, fresh, transferPoint.backToBox);
  }
  return observeGameForeground(phone, await observe(phone), wait);
}

/**
 * The screen is first read after YES. The box list without the transferred
 * CP means the transfer went through; a dialog with a cancel button on two
 * reads in a row is a further confirmation, or the first prompt if YES was
 * lost. Pokémon GO keeps its menu up for seconds while the server answers.
 */
export async function settleAfterConfirm(
  phone: PhoneConnection,
  transferredCp: number,
  wait: Wait = sleep,
  read: (file: string) => Promise<OcrLine[]> = ocr,
) {
  let lastCancel: { x: number; y: number } | null = null;
  let stillListed = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(attempt === 0 ? 300 : 500);
    const screen = await observeGameForeground(phone, await observe(phone), wait);
    if (!screen.image?.path) throw new Error("放生後手機畫面沒有可讀截圖");
    const lines = await read(screen.image.path);
    stillListed = false;
    if (collectionSearchState(lines)) {
      lastCancel = null;
      // A frame from before the list refreshed still shows the old layout.
      if (!cpCandidates(lines).some((candidate) => candidate.cp === transferredCp))
        return { kind: "list" as const, observation: screen, lines };
      stillListed = true;
      continue;
    }
    const cancel = dialogCancelPoint(lines);
    if (
      cancel && lastCancel &&
      Math.abs(cancel.x - lastCancel.x) < 0.03 &&
      Math.abs(cancel.y - lastCancel.y) < 0.03
    )
      return {
        kind: "dialog" as const,
        observation: screen,
        lines,
        cancel,
        standard: standardTransferDialog(lines),
      };
    lastCancel = cancel;
  }
  throw new Error(
    stillListed
      ? "點擊放生後列表仍顯示這隻的 CP"
      : "點擊放生後沒有回到寶可夢列表",
  );
}

/**
 * NO on a transfer prompt leaves the Pokémon's menu open over its detail
 * page. Close what is on top (a dialog with its cancel button, then the menu
 * and the detail page with their X) until the box list shows.
 */
export async function returnToBoxAfterSkip(
  phone: PhoneConnection,
  first: Screen,
  readLines: (path: string) => Promise<OcrLine[]> = ocr,
  wait: Wait = sleep,
) {
  let current = await observeGameForeground(phone, first, wait);
  for (let step = 0; step < 6; step++) {
    if (!current.image?.path) throw new Error("跳過後手機畫面沒有可讀截圖");
    const lines = await readLines(current.image.path);
    if (collectionSearchState(lines) !== null) return current;
    const close = dialogCancelPoint(lines) ?? (
      pokemonMenuOpen(lines) ? transferPoint.menu
        : detailCp(lines) !== null ? transferPoint.closeDetail
        : null
    );
    if (close) {
      try {
        await tapFast(phone, current, close);
      } catch (error) {
        const failure = error as Error & { code?: string; uncertain?: boolean };
        // Rejected before it ran, e.g. under a notification: read again.
        if (failure.code !== "stale_observation" || failure.uncertain !== false)
          throw error;
      }
    }
    await wait(CLOSE_SETTLE_MS);
    current = await observeGameForeground(phone, await observe(phone), wait);
  }
  throw new Error("跳過後按 X 未回到寶可夢盒子列表；請查看手機畫面後再繼續");
}

async function waitForSearchScreen(phone: PhoneConnection) {
  return observeGameForeground(phone, await observe(phone));
}

/** Not read back: OCR of the query was slow and misread `!`. The unique dex+CP check still guards the tap. */
async function submitSearch(
  phone: PhoneConnection, screen: Screen,
) {
  await tapFast(phone, screen, transferPoint.confirmSearch);
}

/** iOS's paste banner covers the result count for a moment after a pasted query. */
export async function observeSearchResults(
  phone: PhoneConnection,
  wait: Wait = sleep,
  read: (file: string) => Promise<OcrLine[]> = ocr,
) {
  for (let attempt = 0; ; attempt++) {
    const result = await observe(phone);
    if (!result.image?.path) throw new Error("搜尋結果沒有可讀截圖");
    const lines = await read(result.image.path);
    if (searchResultCount(lines) !== null || attempt === 5) return { result, lines };
    await wait(500);
  }
}

function setEntry(
  batchId: string,
  index: number,
  patch: Partial<TransferEntry>,
  batchPatch: Partial<TransferBatch> = {},
) {
  const current = get<TransferBatch>("transfer_batches", batchId)!;
  const entries = current.entries.map((row, i) =>
    i === index ? { ...row, ...patch } : row,
  );
  const next = { ...current, ...batchPatch, entries, updatedAt: now() };
  put("transfer_batches", batchId, next);
  return next;
}

export async function locateCp(
  phone: PhoneConnection,
  first: Screen,
  firstLines: OcrLine[],
  dex: number,
  cp: number,
  batchId: string,
  index: number,
  cpQuery: string | null,
) {
  let result = first;
  let lines = firstLines;
  const count = searchResultCount(lines);
  if (count === null)
    throw new Error("無法讀取圖鑑編號的搜尋結果數量");
  if (cpQuery && count !== 1)
    throw new SkippedCandidate(`搜尋 ${cpQuery} 有 ${count} 隻，不是唯一一隻，已跳過且未放生`);
  if (count === 0)
    throw new SkippedCandidate("目前搜尋排除條件下沒有此物種，已跳過且未放生", dex);
  let previous = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!result.image?.path) throw new Error("搜尋結果沒有可讀截圖");
    const visible = cpCandidates(lines);
    const matches = visible.filter((candidate) => candidate.cp === cp);
    if (matches.length > 1)
      throw new Error("搜尋畫面有多隻相同 CP，需人工辨識");
    if (matches.length === 1) {
      const evidence = await saveCapture(
        result,
        batchId,
        `${index}-search-cp`,
      );
      return {
        observation: result,
        point: matches[0],
        evidence: evidence.frame,
      };
    }
    const signature = visible.map((candidate) => `${candidate.cp}:${candidate.x}:${candidate.y}`).join("|");
    if (signature === previous)
      throw new SkippedCandidate("目標 CP 未出現在搜尋結果，已跳過且未放生", dex);
    previous = signature;
    const swiped = await phone.call<{ observation?: Screen }>(
      "swipe",
      {
        direction: "up",
        observation_id: result.observation_id,
        verify: false,
        observe: "screenshot",
      },
    );
    result = swiped.observation?.image?.path
      ? swiped.observation
      : await observe(phone);
    if (!result.image?.path) throw new Error("搜尋翻頁沒有回傳截圖");
    lines = await ocr(result.image.path);
  }
  throw new SkippedCandidate("無法確認目標位於搜尋結果，已跳過且未放生", dex);
}

async function findCandidateByDexCp(
  phone: PhoneConnection,
  current: Screen,
  knownLines: OcrLine[] | null,
  dex: number,
  cp: number,
  batchId: string,
  index: number,
  reuseSearch: boolean,
  extras: readonly TransferSearchFilter[],
  cpSearch: boolean,
) {
  if (!current.image?.path) throw new Error("寶可夢盒子沒有可讀截圖");
  let result = current;
  let lines = knownLines || await ocr(current.image.path);
  const searchState = collectionSearchState(lines);
  if (!searchState)
    throw new Error("請先在寶可夢盒子列表開始逐隻放生");
  const search = async () => {
    if (collectionSearchState(lines) === "active") {
      result = await leaveSearch(phone, result);
      if (!result.image?.path) throw new Error("寶可夢盒子沒有可讀截圖");
      lines = await ocr(result.image.path);
      if (collectionSearchState(lines) !== "empty")
        throw new Error("無法離開目前的搜尋，尚未放生");
    }
    await tapFast(phone, result, transferPoint.search);
    await typeFilteredSearch(phone, dex, extras, cpSearch ? cp : undefined);
    ({ result, lines } = await observeSearchResults(phone));
  };
  let reused = reuseSearch && !cpSearch && searchState === "active" &&
    searchResultCount(lines) !== null;
  if (!reused) await search();
  for (;;) {
    try {
      return await locateCp(phone, result, lines, dex, cp, batchId, index,
        cpSearch ? transferSearchQuery(dex, extras, cp) : null);
    } catch (error) {
      if (!reused || !(error instanceof SkippedCandidate)) throw error;
      // The kept results may be scrolled past the target; search from the top.
      reused = false;
      await search();
    }
  }
}

export async function typeFilteredSearch(
  phone: PhoneConnection,
  dex: number,
  extras: readonly TransferSearchFilter[],
  cp: number | undefined,
  inject: (query: string) => Promise<void> = (query) => phone.typeSearch(query),
  waitForScreen: (phone: PhoneConnection) => Promise<Screen> =
    waitForSearchScreen,
  submit: (phone: PhoneConnection, screen: Screen) => Promise<void> =
    submitSearch,
) {
  const query = transferSearchQuery(dex, extras, cp);
  const screen = await waitForScreen(phone);
  await inject(query);
  await submit(phone, screen);
}

export function authorizedTransferIndex(batch: TransferBatch) {
  if (batch.mode !== "single" || !batch.selectedPokemonId)
    throw new Error("沒有這次明確授權的待放生個體");
  const matches = batch.entries.flatMap((entry, index) =>
    entry.pokemonId === batch.selectedPokemonId && entry.status === "pending"
      ? [index]
      : [],
  );
  if (matches.length !== 1)
    throw new Error("這次授權沒有唯一的待放生個體");
  return matches[0];
}

export function authorizedTransferIndexes(batch: TransferBatch) {
  if (batch.mode !== "bulk") return [authorizedTransferIndex(batch)];
  if (
    !batch.entries.length ||
    batch.entries.some((entry) =>
      !["pending", "submitted", "confirmed", "skipped"].includes(entry.status)
    ) ||
    !batch.entries.some((entry) => entry.status === "pending") ||
    new Set(batch.entries.map((entry) => entry.pokemonId)).size !== batch.entries.length
  ) throw new Error("批次名單沒有唯一且尚待執行的個體");
  return batch.entries.flatMap((entry, index) =>
    entry.status === "pending" ? [index] : [],
  );
}

function entryDex(
  batch: TransferBatch,
  index: number,
  byId: Map<string, Pokemon>,
  snapshot: Snapshot | null,
) {
  const record = byId.get(batch.entries[index].pokemonId);
  const speciesId = record && effective(record).speciesId;
  return (speciesId && snapshot?.species[speciesId]?.dex) || null;
}

/** Same-dex entries run back to back, in the order each dex first appears, so one search serves them all. */
export function transferOrder(
  batch: TransferBatch,
  indexes: number[],
  records: Pokemon[],
  snapshot: Snapshot | null,
) {
  const byId = new Map(records.map((row) => [row.id, row]));
  const groups = new Map<string, number[]>();
  for (const index of indexes) {
    const dex = entryDex(batch, index, byId, snapshot);
    const key = dex ? `dex ${dex}` : `entry ${index}`;
    groups.set(key, [...(groups.get(key) || []), index]);
  }
  return [...groups.values()].flat();
}

export function nextPendingUsesDex(
  batch: TransferBatch,
  order: number[],
  currentIndex: number,
  dex: number,
  records: Pokemon[],
  snapshot: Snapshot | null,
) {
  if (batch.mode !== "bulk" || !snapshot) return false;
  const next = order
    .slice(order.indexOf(currentIndex) + 1)
    .find((index) => batch.entries[index].status === "pending");
  const record = next !== undefined &&
    records.find((row) => row.id === batch.entries[next].pokemonId);
  const speciesId = record && effective(record).speciesId;
  return Boolean(
    record && !transferExclusion(record, snapshot) &&
    speciesId && snapshot.species[speciesId]?.dex === dex,
  );
}

export async function runTransferBatch(
  phone: PhoneConnection,
  requested: TransferBatch,
) {
  let batch = get<TransferBatch>("transfer_batches", requested.id);
  if (!batch || batch.status !== "approved") return;
  const order = transferOrder(
    batch, authorizedTransferIndexes(batch), listPokemon(), getSnapshot(),
  );
  assertBatchFresh(batch);
  batch = { ...batch, status: "running", updatedAt: now() };
  put("transfer_batches", batch.id, batch);
  let current = await ensureReady(phone);
  if (!current.image) current = await observe(phone);
  current = await observeGameForeground(phone, current);
  if (batch.needsBoxReturn) {
    current = await returnToBoxAfterSkip(phone, current);
    const latest = get<TransferBatch>("transfer_batches", batch.id)!;
    if (latest.status !== "running") return;
    batch = { ...latest, needsBoxReturn: false, updatedAt: now() };
    put("transfer_batches", batch.id, batch);
  }
  // OCR of `current` when already read, and the dex its search results show.
  let currentLines: OcrLine[] | null = null;
  let shownDex: number | null = null;
  for (const index of order) {
    batch = get<TransferBatch>("transfer_batches", batch.id)!;
    if (batch.status !== "running") return;
    const entry = batch.entries[index];
    if (entry.status !== "pending") continue;
    let favoriteRemoved = false;
    try {
      assertBatchFresh(batch);
      const record = listPokemon().find((row) => row.id === entry.pokemonId);
      if (!record || transferExclusion(record, getSnapshot()))
        throw new Error("目前分析已不符合放生條件");
      let identity: ReturnType<typeof assertUniqueDexCp>;
      try {
        identity = assertUniqueDexCp(
          record,
          listPokemon(),
          getSnapshot(),
          completeBoxIds() ?? null,
        );
      } catch (error) {
        if ((error as Error).message.includes("多隻相同圖鑑編號與 CP"))
          throw new SkippedCandidate("同圖鑑編號與 CP 不唯一，已跳過且未放生");
        throw error;
      }
      const extras = batch.searchExclusions || defaultTransferSearchFilters;
      batch = setEntry(batch.id, index, {
        status: "searching",
        reason: `正在搜尋 ${transferSearchQuery(identity.dex, extras, identity.cpSearch ? identity.cp : undefined)} 的唯一 CP`,
      });
      // A dex&cp search replaces whatever dex results the screen showed.
      if (identity.cpSearch) shownDex = null;
      let found: Awaited<ReturnType<typeof findCandidateByDexCp>>;
      for (let attempt = 0; ; attempt++) {
        const screen = await observeGameForeground(phone, current);
        if (screen !== current) currentLines = null;
        current = screen;
        try {
          found = await findCandidateByDexCp(
            phone, current, currentLines, identity.dex, identity.cp, batch.id, index,
            attempt === 0 && shownDex === identity.dex,
            extras,
            identity.cpSearch,
          );
          await tapFast(phone, found.observation, found.point);
          break;
        } catch (error) {
          if (
            attempt !== 0 ||
            (error as Error & { code?: string }).code !== "stale_observation"
          ) throw error;
          // WDA rejected the old app/viewport context before this tap. Read
          // the screen and plan the search again; never replay a sent transfer.
          current = await observe(phone);
          currentLines = null;
        }
      }
      currentLines = null;
      shownDex = identity.cpSearch ? null : identity.dex;
      batch = setEntry(batch.id, index, {
        status: "prepared",
        preparedAt: now(),
        evidence: found.evidence,
      });
      if (effective(record).favorite === true) {
        batch = setEntry(batch.id, index, {
          status: "unfavoriting",
        });
        await tapFast(phone, found.observation, transferPoint.favorite);
        favoriteRemoved = true;
        batch = setEntry(batch.id, index, {
          status: "prepared",
        });
      }
      await tapFast(phone, found.observation, transferPoint.menu);
      await tapFast(phone, found.observation, transferPoint.transfer);
      await sleep(CONFIRM_DELAY_MS);
      const liveBatch = get<TransferBatch>("transfer_batches", batch.id)!;
      if (
        liveBatch.status !== "running" ||
        (liveBatch.mode !== "bulk" && liveBatch.selectedPokemonId !== record.id)
      )
        throw new Error("放生已停止，尚未送出指令");
      assertBatchFresh(liveBatch);
      const currentRecord = get<Pokemon>("pokemon", record.id);
      if (!currentRecord || transferExclusion(currentRecord, getSnapshot()))
        throw new Error("放生前收藏狀態已改變");
      // Persist intent before the irreversible tap. A crash after this point is uncertain.
      batch = setEntry(batch.id, index, { status: "sent", sentAt: now() });
      await tapFast(phone, found.observation, transferPoint.confirm);
      const batchId = batch.id;
      let outcome: Awaited<ReturnType<typeof settleAfterConfirm>> | null = null;
      let settleError: unknown = null;
      try {
        outcome = await settleAfterConfirm(phone, identity.cp);
      } catch (error) {
        settleError = error;
      }
      if (outcome?.kind === "dialog") {
        const prompt = outcome.standard
          ? "點擊 YES 後放生確認仍在"
          : `放生時出現額外確認「${dialogText(outcome.lines).slice(0, 120)}」`;
        const evidence = await saveCapture(outcome.observation, batchId, `${index}-extra-confirm`);
        const kept = favoriteRemoved ? "；遊戲內最愛已取消" : "";
        try {
          await tapFast(phone, outcome.observation, outcome.cancel);
        } catch (error) {
          setEntry(batchId, index, {
            status: "skipped",
            reason: `${prompt}，按 NO 失敗，未放生${kept}`,
            evidence: evidence.frame,
          }, {
            status: "paused",
            selectedPokemonId: null,
            approvedAt: null,
            needsBoxReturn: true,
            error: `${prompt}，按 NO 失敗；這隻未放生，請在手機按 NO 後繼續：${error instanceof Error ? error.message : "未知錯誤"}`,
          });
          return;
        }
        // NO on a confirmation keeps the Pokémon; nothing was transferred.
        batch = setEntry(batchId, index, {
          status: "skipped",
          reason: `${prompt}，已按 NO 取消，未放生${kept}`,
          evidence: evidence.frame,
        });
        try {
          await sleep(CLOSE_SETTLE_MS);
          current = await returnToBoxAfterSkip(phone, await observe(phone));
        } catch (error) {
          setEntry(batchId, index, {}, {
            status: "paused",
            selectedPokemonId: null,
            approvedAt: null,
            needsBoxReturn: true,
            error: `已按 NO 取消放生，這隻未放生；返回列表失敗：${error instanceof Error ? error.message : "未知錯誤"}`,
          });
          return;
        }
        currentLines = null;
        shownDex = null;
        if (batch.mode !== "bulk") break;
        continue;
      }
      transaction(() => {
        const latest = get<Pokemon>("pokemon", record.id)!;
        put("pokemon", latest.id, { ...latest, owned: false, updatedAt: now() });
        batch = setEntry(batchId, index, {
          status: "submitted",
          reason: "已點擊放生；依設定未核對遊戲結果",
          submittedAt: now(),
        });
      });
      reevaluate();
      batch.signature = transferSignature(
        batch,
        listPokemon(),
        getSnapshot(),
        getSettings(),
      );
      put("transfer_batches", batch.id, batch);
      try {
        if (settleError) throw settleError;
        current = outcome!.observation;
        currentLines = outcome!.lines;
        if (
          collectionSearchState(currentLines) === "active" &&
          !nextPendingUsesDex(batch, order, index, identity.dex, listPokemon(), getSnapshot())
        ) {
          // The next species, or the user, starts from the whole box.
          current = await leaveSearch(phone, current);
          currentLines = null;
          shownDex = null;
        }
      } catch (error) {
        batch = setEntry(batchId, index, {
          reason: `已點擊放生並更新收藏；返回寶可夢列表失敗：${error instanceof Error ? error.message : "未知錯誤"}`,
        });
        if (batch.mode === "bulk") throw error;
      }
      if (batch.mode !== "bulk") break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知錯誤";
      const latest = get<TransferBatch>("transfer_batches", batch.id)!;
      const state = latest.entries[index].status;
      if (error instanceof SkippedCandidate && !favoriteRemoved &&
          ["pending", "searching"].includes(state)) {
        batch = setEntry(batch.id, index, { status: "skipped", reason: message });
        if (batch.mode !== "bulk") break;
        current = await observe(phone);
        currentLines = null;
        shownDex = error.shownDex ?? shownDex;
        continue;
      }
      if (state === "submitted") {
        setEntry(batch.id, index, {
          reason: `已點擊放生並更新收藏，未核對遊戲結果；後續導航失敗：${message}`,
        }, {
          status: "paused",
          selectedPokemonId: null,
          approvedAt: null,
          error: `已點擊放生並更新收藏；後續導航失敗，請檢查手機畫面：${message}`,
        });
        return;
      }
      const uncertain = state === "sent" || state === "unfavoriting";
      setEntry(
        batch.id,
        index,
        {
          status: uncertain ? "uncertain" : "skipped",
          reason: favoriteRemoved
            ? `已取消遊戲內最愛；${message}`
            : message,
        },
        {
          status: latest.status === "stopped" ? "stopped" : "paused",
          selectedPokemonId: null,
          approvedAt: null,
          error:
            state === "sent"
              ? `可能已執行放生，請在遊戲查證：${message}`
              : state === "unfavoriting"
                ? `取消最愛結果不明，尚未送出放生，請在遊戲查證：${message}`
                : favoriteRemoved
                  ? `遊戲內最愛已取消，尚未放生，請查證：${message}`
                  : message,
        },
      );
      return;
    }
  }
  batch = get<TransferBatch>("transfer_batches", batch.id)!;
  put("transfer_batches", batch.id, {
    ...batch,
    status:
      batch.status === "stopped"
        ? "stopped"
        : batch.entries.some((entry) => entry.status === "pending")
          ? "draft"
          : "completed",
    selectedPokemonId: null,
    approvedAt: null,
    updatedAt: now(),
  });
}
