/** Prepare slow work concurrently, then apply results in the source order. */
export async function processPreparedInOrder<T, R>(input: {
  items: T[];
  needsPreparation: (item: T) => boolean;
  active: () => boolean;
  prepare: (item: T, signal: AbortSignal) => Promise<R>;
  consume: (item: T, result: R) => Promise<void>;
  concurrency?: number;
}): Promise<boolean> {
  const concurrency = Math.max(1, Math.min(8, input.concurrency || 3));
  const pending = new Map<
    number,
    { controller: AbortController; promise: Promise<R> }
  >();
  const schedule = (index: number) => {
    for (
      let next = index;
      next < Math.min(input.items.length, index + concurrency);
      next++
    ) {
      if (!input.needsPreparation(input.items[next]) || pending.has(next))
        continue;
      const controller = new AbortController();
      const promise = input.prepare(input.items[next], controller.signal);
      // A later item may reject before its turn; await it in source order.
      promise.catch(() => {});
      pending.set(next, { controller, promise });
    }
  };
  const abortPending = () => {
    for (const task of pending.values()) task.controller.abort();
  };
  const watcher = setInterval(() => {
    if (!input.active()) abortPending();
  }, 500);
  try {
    for (const [index, item] of input.items.entries()) {
      if (!input.active()) return false;
      schedule(index);
      if (!input.needsPreparation(item)) continue;
      try {
        const result = await pending.get(index)!.promise;
        if (!input.active()) return false;
        await input.consume(item, result);
      } catch (error) {
        if (!input.active()) return false;
        throw error;
      }
      pending.delete(index);
    }
    return true;
  } finally {
    clearInterval(watcher);
    abortPending();
    await Promise.allSettled([...pending.values()].map((task) => task.promise));
  }
}
