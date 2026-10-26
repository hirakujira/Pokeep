import OpenAI from "openai";

export function openAiBaseURL() {
  const value = process.env.OPENAI_BASE_URL?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "OPENAI_BASE_URL 必須是完整的 HTTP(S) 網址，例如 http://127.0.0.1:1234/v1",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("OPENAI_BASE_URL 必須是沒有帳密的 HTTP(S) 網址");
  return url.toString().replace(/\/$/, "");
}

export function openAiClient(options: { maxRetries: number; timeout: number }) {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("尚未設定 OPENAI_API_KEY；請在 .env.local 設定後重啟。");
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: openAiBaseURL(),
    ...options,
  });
}
