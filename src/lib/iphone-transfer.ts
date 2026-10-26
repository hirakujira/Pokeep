import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { IphoneMcp } from "./iphone-mcp";
import { hasBackgroundExclamationGlyph } from "./iphone-query-glyph";
import { injectSearchText } from "./iphone-direct-input";
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
import { all, get, getSettings, getSnapshot, listPokemon, now, put, transaction } from "./store";
import { reevaluate } from "./evaluate";
import type { Scan, ScanItem, TransferBatch, TransferEntry } from "./iphone-types";
import { readLocalOcr } from "./local-ocr";
import {
  assertUniqueDexCp,
  backgroundQuery,
  backgroundQueryMatches,
  collectionSearchState,
  cpCandidates,
  croppedBackgroundTextCompatible,
  croppedNonBackgroundConsensus,
  nonBackgroundQuery,
  nonBackgroundQueryMatches,
  searchQueryMatches,
  searchResultCount,
  standardTransferDialog,
} from "./iphone-transfer-search";

class SkippedCandidate extends Error {}

// Supported portrait layout, calibrated on Gjallarhorn. The final tap is
// always preceded by a durable sent journal entry and a local OCR prompt check.
const transferPoint = {
  search: { x: 0.5, y: 0.177 },
  clearSearch: { x: 0.92, y: 0.177 },
  backToBox: { x: 0.095, y: 0.177 },
  confirmSearch: { x: 0.752, y: 0.588 },
  favorite: { x: 0.9, y: 0.077 },
  menu: { x: 0.865, y: 0.94 },
  transfer: { x: 0.74, y: 0.854 },
  confirm: { x: 0.5, y: 0.534 },
} as const;

async function tapFast(
  phone: IphoneMcp,
  observation: Awaited<ReturnType<typeof observe>>,
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
  phone: IphoneMcp,
  first: Awaited<ReturnType<typeof observe>>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
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

/** Recover only post-transfer navigation. The irreversible transfer tap is never replayed. */
export async function settleAfterSubmitted(
  phone: IphoneMcp,
  dialog: Awaited<ReturnType<typeof observe>>,
  keepSearch: boolean,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  await wait(700);
  if (!keepSearch) {
    try {
      await tapFast(phone, dialog, transferPoint.backToBox);
    } catch (error) {
      const failure = error as Error & { code?: string; uncertain?: boolean };
      if (failure.code !== "stale_observation" || failure.uncertain !== false)
        throw error;
      // The old-screen tap was explicitly rejected before execution. Wait
      // through a notification, then retry this navigation tap from a new frame.
      const fresh = await observeGameForeground(phone, await observe(phone), wait);
      await tapFast(phone, fresh, transferPoint.backToBox);
    }
  }
  return observeGameForeground(phone, await observe(phone), wait);
}

async function waitForSearchScreen(phone: IphoneMcp) {
  await observeGameForeground(phone, await observe(phone));
}

/** Full-frame OCR sometimes drops the thin !. Re-read only the search text. */
export async function confirmNonBackgroundQuery(imagePath: string, lines: Awaited<ReturnType<typeof readLocalOcr>>[number], dex: number) {
  if (nonBackgroundQueryMatches(lines, dex)) return true;
  if (backgroundQueryMatches(lines, dex) &&
      await hasBackgroundExclamationGlyph(imagePath)) return true;
  const metadata = await sharp(imagePath).metadata();
  if (!metadata.width || !metadata.height) return false;
  const region = {
    left: Math.round(metadata.width * 0.22),
    top: Math.round(metadata.height * 0.155),
    width: Math.round(metadata.width * 0.55),
    height: Math.round(metadata.height * 0.052),
  };
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pokekeep-query-"));
  try {
    const plain = path.join(folder, "plain.png");
    const normalized = path.join(folder, "normalized.png");
    const sharpened = path.join(folder, "sharpened.png");
    await Promise.all([
      sharp(imagePath).extract(region).resize({ width: region.width * 3 }).png().toFile(plain),
      sharp(imagePath).extract(region).resize({ width: region.width * 3 })
        .grayscale().normalise().png().toFile(normalized),
      sharp(imagePath).extract(region).resize({ width: region.width * 3 })
        .grayscale().normalise().sharpen().png().toFile(sharpened),
    ]);
    const cropped = await readLocalOcr([plain, normalized, sharpened]);
    if (croppedNonBackgroundConsensus(cropped, dex)) return true;
    return croppedBackgroundTextCompatible(cropped, dex) &&
      await hasBackgroundExclamationGlyph(imagePath);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

async function submitSearch(phone: IphoneMcp, dex: number, background: boolean | "exclude-background") {
  const screen = await observeGameForeground(phone, await observe(phone));
  if (!screen.image?.path) throw new Error("搜尋輸入後沒有可讀畫面");
  const [lines] = await readLocalOcr([screen.image.path]);
  const matches = background === "exclude-background"
    ? await confirmNonBackgroundQuery(screen.image.path, lines, dex)
    : background ? backgroundQueryMatches(lines, dex) : searchQueryMatches(lines, dex);
  if (!matches) throw new Error("無法確認搜尋欄包含圖鑑編號與 !背卡，尚未送出搜尋");
  await tapFast(phone, screen, transferPoint.confirmSearch);
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

async function findCandidateByDexCp(
  phone: IphoneMcp,
  current: Awaited<ReturnType<typeof observe>>,
  dex: number,
  cp: number,
  batchId: string,
  index: number,
  reuseSearch: boolean,
) {
  if (!current.image?.path) throw new Error("寶可夢盒子沒有可讀截圖");
  const [initialLines] = await readLocalOcr([current.image.path]);
  const searchState = collectionSearchState(initialLines);
  if (!searchState)
    throw new Error("請先在寶可夢盒子列表開始逐隻放生");
  let result = current;
  let lines = initialLines;
  if (!reuseSearch || searchState !== "active" || !await confirmNonBackgroundQuery(current.image.path, lines, dex)) {
    if (searchState === "active")
      await tapFast(phone, current, transferPoint.clearSearch);
    await tapFast(phone, current, transferPoint.search);
    await typeNonBackgroundSearch(phone, dex);
    result = await observe(phone);
    if (!result.image?.path) throw new Error("搜尋結果沒有可讀截圖");
    [lines] = await readLocalOcr([result.image.path]);
  }
  if (!result.image?.path) throw new Error("搜尋結果沒有可讀截圖");
  if (!await confirmNonBackgroundQuery(result.image.path, lines, dex))
    throw new Error("搜尋欄未顯示完整圖鑑編號與排除背卡條件，尚未放生");
  const count = searchResultCount(lines);
  if (count === null)
    throw new Error("無法讀取圖鑑編號的搜尋結果數量");
  if (count === 0)
    throw new SkippedCandidate("搜尋結果沒有此物種，已跳過且未放生");
  let previous = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!result.image?.path) throw new Error("搜尋結果沒有可讀截圖");
    if (!await confirmNonBackgroundQuery(result.image.path, lines, dex))
      throw new Error("搜尋結果已失去排除背卡條件，尚未放生");
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
      throw new SkippedCandidate("目標 CP 未出現在搜尋結果，已跳過且未放生");
    previous = signature;
    const swiped = await phone.call<{ observation?: Awaited<ReturnType<typeof observe>> }>(
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
    [lines] = await readLocalOcr([result.image.path]);
  }
  throw new SkippedCandidate("無法確認目標位於搜尋結果，已跳過且未放生");
}

function completeBoxIds() {
  const latest = all<Scan>("scans")
    .filter((scan) => scan.scope === "all" && scan.status === "completed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!latest) return null;
  const items = all<ScanItem>("scan_items").filter(
    (item) => item.scanId === latest.id && item.pokemonId,
  );
  return items.length === latest.scanned
    ? new Set(items.map((item) => item.pokemonId!))
    : null;
}

export async function typeNumericSearch(
  phone: IphoneMcp,
  dex: number,
  inject: (query: string) => Promise<void> = injectSearchText,
  waitForScreen: (phone: IphoneMcp) => Promise<void> = waitForSearchScreen,
  submit: (phone: IphoneMcp, dex: number, background: boolean) => Promise<void> = submitSearch,
) {
  if (!Number.isInteger(dex) || dex < 1 || dex > 10000)
    throw new Error("沒有可靠的圖鑑編號，無法搜尋候選");
  await waitForScreen(phone);
  await inject(String(dex));
  await submit(phone, dex, false);
}

export async function typeBackgroundSearch(
  phone: IphoneMcp,
  dex: number,
  inject: (query: string) => Promise<void> = injectSearchText,
  waitForScreen: (phone: IphoneMcp) => Promise<void> = waitForSearchScreen,
  submit: (phone: IphoneMcp, dex: number, background: boolean) => Promise<void> = submitSearch,
) {
  const query = backgroundQuery(dex);
  await waitForScreen(phone);
  await inject(query);
  await submit(phone, dex, true);
}

export async function typeNonBackgroundSearch(
  phone: IphoneMcp,
  dex: number,
  inject: (query: string) => Promise<void> = injectSearchText,
  waitForScreen: (phone: IphoneMcp) => Promise<void> = waitForSearchScreen,
  submit: (phone: IphoneMcp, dex: number, background: boolean | "exclude-background") => Promise<void> = submitSearch,
) {
  const query = nonBackgroundQuery(dex);
  await waitForScreen(phone);
  await inject(query);
  await submit(phone, dex, "exclude-background");
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

export function nextPendingUsesDex(
  batch: TransferBatch,
  currentIndex: number,
  dex: number,
  records: Pokemon[],
  snapshot: Snapshot | null,
) {
  if (batch.mode !== "bulk" || !snapshot) return false;
  const next = batch.entries.slice(currentIndex + 1).find((entry) => entry.status === "pending");
  const record = next && records.find((row) => row.id === next.pokemonId);
  const speciesId = record && effective(record).speciesId;
  return Boolean(
    record && !transferExclusion(record, snapshot) &&
    speciesId && snapshot.species[speciesId]?.dex === dex,
  );
}

export async function runTransferBatch(
  phone: IphoneMcp,
  requested: TransferBatch,
) {
  let batch = get<TransferBatch>("transfer_batches", requested.id);
  if (!batch || batch.status !== "approved") return;
  const authorizedIndexes = new Set(authorizedTransferIndexes(batch));
  assertBatchFresh(batch);
  batch = { ...batch, status: "running", updatedAt: now() };
  put("transfer_batches", batch.id, batch);
  let current = await ensureReady(phone);
  if (!current.image) current = await observe(phone);
  current = await observeGameForeground(phone, current);
  let reusableDex: number | null = null;
  for (let index = 0; index < batch.entries.length; index++) {
    batch = get<TransferBatch>("transfer_batches", batch.id)!;
    if (batch.status !== "running") return;
    const entry = batch.entries[index];
    if (entry.status !== "pending") continue;
    if (!authorizedIndexes.has(index)) continue;
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
          completeBoxIds(),
        );
      } catch (error) {
        if ((error as Error).message.includes("多隻相同圖鑑編號與 CP"))
          throw new SkippedCandidate("同圖鑑編號與 CP 不唯一，已跳過且未放生");
        throw error;
      }
      batch = setEntry(batch.id, index, {
        status: "searching",
        reason: "正在搜尋無背卡的唯一 CP",
      });
      let found: Awaited<ReturnType<typeof findCandidateByDexCp>>;
      for (let attempt = 0; ; attempt++) {
        current = await observeGameForeground(phone, current);
        try {
          found = await findCandidateByDexCp(
            phone, current, identity.dex, identity.cp, batch.id, index,
            attempt === 0 && reusableDex === identity.dex,
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
        }
      }
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
      let dialog = await observe(phone);
      let standardDialog = false;
      for (let check = 0; check < 3; check++) {
        if (!dialog.image?.path) throw new Error("放生確認畫面沒有截圖");
        const [dialogLines] = await readLocalOcr([dialog.image.path]);
        if (standardTransferDialog(dialogLines)) {
          standardDialog = true;
          break;
        }
        if (check < 2) dialog = await observe(phone);
      }
      if (!standardDialog)
        throw new Error("不是一般放生確認畫面，或出現額外警告；尚未放生");
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
      await tapFast(phone, dialog, transferPoint.confirm);
      // The user opted out of checking the post-transfer game screen. Treat a
      // successful tap response as submitted, not as an observed game result.
      const batchId = batch.id;
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
      const keepSearch = nextPendingUsesDex(
        batch, index, identity.dex, listPokemon(), getSnapshot(),
      );
      try {
        // Same-dex candidates can use the filtered box directly. Otherwise
        // exit search so the next candidate starts from the unfiltered box.
        current = await settleAfterSubmitted(phone, dialog, keepSearch);
      } catch (error) {
        batch = setEntry(batchId, index, {
          reason: `已點擊放生並更新收藏；返回寶可夢列表失敗：${error instanceof Error ? error.message : "未知錯誤"}`,
        });
        if (batch.mode === "bulk") throw error;
      }
      if (batch.mode !== "bulk") break;
      reusableDex = keepSearch ? identity.dex : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知錯誤";
      const latest = get<TransferBatch>("transfer_batches", batch.id)!;
      const state = latest.entries[index].status;
      if (error instanceof SkippedCandidate && !favoriteRemoved &&
          ["pending", "searching"].includes(state)) {
        batch = setEntry(batch.id, index, { status: "skipped", reason: message });
        if (batch.mode !== "bulk") break;
        current = await observe(phone);
        reusableDex = null;
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
