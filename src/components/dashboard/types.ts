import type { Pokemon, Settings } from "@/lib/types";
import type { Scan, TransferBatch } from "@/lib/iphone-types";
import type { ScanTiming } from "@/lib/scan-timing";
import type { PublicRuntimeConfig } from "@/lib/runtime-config";

export type SnapshotInfo = {
  version: string;
  updatedAt: string;
  sourceDate: string;
  count: number;
  sources: { name: string; url: string; version: string }[];
  warnings: string[];
};
export type State = {
  pokemon: Pokemon[];
  settings: Settings;
  snapshot: SnapshotInfo | null;
  apiConfigured: boolean;
  model: string;
  runtime: PublicRuntimeConfig;
};
export type Catalog = {
  species: { id: string; dex: number; name: string; types: string[] }[];
  moves: { id: string; name: string }[];
};
export type Tab = "iphone" | "results" | "settings";
export type PhoneState = {
  worker: {
    updatedAt: string;
    ready: boolean;
    message: string;
    version: string | null;
  } | null;
  scan: (Scan & { timing?: ScanTiming }) | null;
  batch: TransferBatch | null;
  resumableBatches: (TransferBatch & { resumeBlocked: string | null })[];
};
export type PhoneStatus = { tone: string; label: string };
export type RunAction = (label: string, fn: () => Promise<void>) => Promise<void>;
export type Notify = (message: string) => void;
