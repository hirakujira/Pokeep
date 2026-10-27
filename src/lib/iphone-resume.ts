import type { TransferBatch } from "./iphone-types";

/** Only the last pre-action failure and untouched entries may be retried. */
export function resumableTransferIndexes(batch: TransferBatch): number[] {
  if (batch.status !== "paused") return [];
  if (batch.entries.some((entry) =>
    ["searching", "unfavoriting", "prepared", "sent", "uncertain"].includes(entry.status),
  )) return [];
  let retry = -1;
  if (batch.error) {
    for (let index = batch.entries.length - 1; index >= 0; index--) {
      const entry = batch.entries[index];
      const preSubmitDialogFailure =
        entry.reason === "不是一般放生確認畫面，或出現額外警告；尚未放生";
      if (
        entry.status === "skipped" && entry.reason === batch.error &&
        (!entry.preparedAt && !entry.evidence || preSubmitDialogFailure) &&
        !entry.sentAt && !entry.submittedAt && !entry.confirmedAt
      ) {
        retry = index;
        break;
      }
    }
  }
  if (batch.mode === "single") return retry < 0 ? [] : [retry];
  return batch.entries.flatMap((entry, index) =>
    entry.status === "pending" || index === retry ? [index] : [],
  );
}

/** The failed entry may be left behind only when no transfer tap was sent. */
export function skippableTransferIndex(batch: TransferBatch): number | null {
  if (batch.status !== "paused" || batch.mode !== "bulk" || !batch.error ||
      !batch.entries.some((entry) => entry.status === "pending") ||
      batch.entries.some((entry) =>
        ["searching", "unfavoriting", "prepared", "sent", "uncertain"].includes(entry.status),
      )) return null;
  for (let index = batch.entries.length - 1; index >= 0; index--) {
    const entry = batch.entries[index];
    if (entry.status === "skipped" && entry.reason === batch.error &&
        !entry.sentAt && !entry.submittedAt && !entry.confirmedAt &&
        batch.entries.slice(index + 1).every((later) => later.status === "pending"))
      return index;
  }
  return null;
}
