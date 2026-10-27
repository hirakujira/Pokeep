import { test } from "node:test";
import assert from "node:assert/strict";

const { api } = await import("../src/components/dashboard/api");

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
