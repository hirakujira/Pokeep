export function trackPending(task: () => Promise<void>) {
  let pending = 0;
  const run = async () => {
    pending++;
    try {
      await task();
    } finally {
      pending--;
    }
  };
  return { run, poll: () => (pending ? Promise.resolve() : run()) };
}
