import type { Fields } from "./types";
import type { MaxStatus } from "./max-status";

export type ScanStatus =
  "queued" | "running" | "paused" | "completed" | "stopped" | "failed";
export type Scan = {
  id: string;
  scope: "results" | "all";
  status: ScanStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  scanned: number;
  phase?: "capture" | "analysis";
  analyzed?: number;
  review: number;
  expected: number | null;
  sort: string | null;
  currentFrame: string | null;
  lastFingerprint: string | null;
  apiUsage: {
    input: number;
    output: number;
    requests: number;
    cached: number;
    navigationRequests?: number;
    dataRequests?: number;
  };
  error: string | null;
  checkpointRequired: boolean;
  iphoneUseVersion: string | null;
};
export type ScanItem = {
  id: string;
  scanId: string;
  position: number;
  frame: string;
  appraisalFrame: string | null;
  movesFrame?: string;
  measuredIV?: number[] | null;
  fingerprint: string;
  pokemonId: string | null;
  fields: Fields | null;
  issues: string[];
  protectionClear: boolean;
  favoriteRechecked?: boolean;
  evolutionSilhouette?: boolean | null;
  maxStatus?: MaxStatus | null;
  shinyReview?: {
    verdict: "normal" | "shiny" | "uncertain";
    model: string;
    reason: string;
    referenceHashes?: string[];
    reviewedAt: string;
  };
  capturedAt: string;
};
export type TransferEntry = {
  pokemonId: string;
  status:
    | "pending"
    | "searching"
    | "unfavoriting"
    | "prepared"
    | "sent"
    | "submitted"
    | "confirmed"
    | "skipped"
    | "uncertain";
  reason: string | null;
  preparedAt?: string;
  sentAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  evidence?: string;
};
export type TransferBatch = {
  id: string;
  scanId: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "draft"
    | "approved"
    | "running"
    | "paused"
    | "completed"
    | "stopped"
    | "stale";
  mode?: "single" | "bulk";
  selectedPokemonId?: string | null;
  signature: string;
  entries: TransferEntry[];
  error: string | null;
  approvedAt: string | null;
};
