import OpenAI from "openai";
import { getRuntimeConfig, validateBaseUrl } from "./runtime-config";

export function openAiBaseURL() {
  return validateBaseUrl(getRuntimeConfig().baseUrl) || undefined;
}

export function openAiClient(options: { maxRetries: number; timeout: number }) {
  const config = getRuntimeConfig();
  if (!config.apiKey)
    throw new Error("尚未設定 API key；請到網頁的「設定」頁填入。");
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: openAiBaseURL() || "https://api.openai.com/v1",
    ...options,
  });
}
