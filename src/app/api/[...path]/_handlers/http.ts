import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
export async function body(req: NextRequest, max = 2 * 1024 * 1024) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("缺少請求內容");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("資料過大");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("JSON 格式不正確");
  }
}
export function guard(req: NextRequest, mutation = false) {
  const hostHeader = req.headers.get("host") || "",
    host = hostHeader.startsWith("[")
      ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
      : hostHeader.split(":")[0];
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    throw new Error("僅允許本機存取");
  const origin = req.headers.get("origin");
  // Next's production request.url can use its internal hostname; compare the browser origin to the validated Host instead.
  if (
    mutation &&
    (req.headers.get("x-pogo-local") !== "1" ||
      (origin && (!URL.canParse(origin) || new URL(origin).host !== hostHeader)))
  )
    throw new Error("拒絕跨網站寫入請求");
}
export function errorResponse(error: unknown) {
  const message =
    error instanceof z.ZodError
      ? "欄位格式不正確：" +
        error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .slice(0, 5)
          .join("；")
      : error instanceof Error
        ? error.message
        : "發生未知錯誤";
  return json({ error: message }, 400);
}
