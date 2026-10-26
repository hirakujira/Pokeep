import path from "node:path";
import { z } from "zod";
import { get, put } from "./store";

export const defaultRuntimeConfig = {
  apiKey: null as string | null,
  model: "gpt-4.1-mini",
  baseUrl: "",
  analysisConcurrency: 6,
  shinyReviewConcurrency: 6,
  iphoneUseRoot: "/Users/Hiraku/Develop/utils/iPhone-use",
  iphoneUsePython: "python3",
};
export type RuntimeConfig = typeof defaultRuntimeConfig;
export type PublicRuntimeConfig = Omit<RuntimeConfig, "apiKey"> & {
  apiConfigured: boolean;
};

const patchSchema = z.object({
  apiKey: z.string().max(512).optional(),
  clearApiKey: z.boolean().optional(),
  model: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().max(1000).optional(),
  analysisConcurrency: z.number().int().min(1).max(8).optional(),
  shinyReviewConcurrency: z.number().int().min(1).max(8).optional(),
  iphoneUseRoot: z.string().trim().max(1000).optional(),
  iphoneUsePython: z.string().trim().max(1000).optional(),
}).strict();

export function validateBaseUrl(value: string): string {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AI 伺服器網址必須是完整的 HTTP(S) 網址，並包含 /v1");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("AI 伺服器網址只能包含 HTTP(S) 主機與路徑，不能含帳密或查詢參數");
  return url.toString().replace(/\/$/, "");
}

export function getRuntimeConfig(): RuntimeConfig {
  return { ...defaultRuntimeConfig, ...get<Partial<RuntimeConfig>>("settings", "runtime-config") };
}

export function publicRuntimeConfig(config = getRuntimeConfig()): PublicRuntimeConfig {
  const { apiKey, ...rest } = config;
  return { ...rest, apiConfigured: Boolean(apiKey) };
}

export function saveRuntimeConfig(input: unknown): PublicRuntimeConfig {
  const patch = patchSchema.parse(input);
  if (patch.clearApiKey && patch.apiKey?.trim())
    throw new Error("不能同時設定與清除 API key");
  const current = getRuntimeConfig();
  const root = patch.iphoneUseRoot ?? current.iphoneUseRoot;
  if (!path.isAbsolute(root)) throw new Error("iPhone Use 位置必須是絕對路徑");
  const python = patch.iphoneUsePython ?? current.iphoneUsePython;
  if (!/^(?:python(?:3(?:\.\d+)?)?|\/[^\0]+\/python(?:3(?:\.\d+)?)?)$/.test(python))
    throw new Error("Python 指令只能是 python3 或絕對路徑的 Python 執行檔");
  const next: RuntimeConfig = {
    apiKey: patch.clearApiKey ? null : patch.apiKey?.trim() || current.apiKey,
    model: patch.model ?? current.model,
    baseUrl: validateBaseUrl(patch.baseUrl ?? current.baseUrl),
    analysisConcurrency: patch.analysisConcurrency ?? current.analysisConcurrency,
    shinyReviewConcurrency: patch.shinyReviewConcurrency ?? current.shinyReviewConcurrency,
    iphoneUseRoot: root,
    iphoneUsePython: python,
  };
  put("settings", "runtime-config", next);
  return publicRuntimeConfig(next);
}
