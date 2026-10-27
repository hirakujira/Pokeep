export async function api<T = unknown>(
  url: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const r = await fetch(`/api/${url}`, {
    method,
    headers: {
      "x-pogo-local": "1",
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  let result;
  try {
    result = await r.json();
  } catch {
    throw new Error(r.ok ? "伺服器回應格式不正確" : `操作失敗（HTTP ${r.status}）`);
  }
  if (!r.ok) throw new Error(result?.error || "操作失敗");
  return result;
}
