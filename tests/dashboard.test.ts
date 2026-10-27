import { test } from "node:test";
import assert from "node:assert/strict";

const { api } = await import("../src/components/dashboard/api");
const { trackPending } = await import("../src/components/dashboard/track-pending");

test("API 回傳非 JSON 時顯示可理解的錯誤", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html>Bad Gateway</html>", { status: 502 });
    await assert.rejects(() => api("state"), { message: "操作失敗（HTTP 502）" });
    globalThis.fetch = async () => new Response("<html>ok</html>", { status: 200 });
    await assert.rejects(() => api("state"), { message: "伺服器回應格式不正確" });
    globalThis.fetch = async () => Response.json({ error: "僅允許本機存取" }, { status: 400 });
    await assert.rejects(() => api("state"), { message: "僅允許本機存取" });
    globalThis.fetch = async () => Response.json({ ok: true });
    assert.deepEqual(await api("state"), { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("輪詢在上一個請求未完成時跳過，手動重新整理照常送出", async () => {
  let calls = 0;
  const resolvers: (() => void)[] = [];
  const loader = trackPending(() => {
    calls++;
    return new Promise<void>((resolve) => resolvers.push(resolve));
  });
  const first = loader.poll();
  void loader.poll();
  assert.equal(calls, 1);
  const manual = loader.run();
  assert.equal(calls, 2);
  resolvers.forEach((resolve) => resolve());
  await Promise.all([first, manual]);
  const next = loader.poll();
  assert.equal(calls, 3);
  resolvers[2]();
  await next;
});
