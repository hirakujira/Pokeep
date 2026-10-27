import { z } from "zod";
import {
  evolutionSilhouetteSchema,
  fieldsSchema,
  frameSchema,
  ivMeasuredSchema,
  maxStatusSchema,
} from "./types";
import {
  maxTransferSearchFilters,
  transferSearchFilters,
  type TransferSearchFilter,
} from "./transfer-search-filters";

export const scanSchema = z.object({
  id: z.string().max(100),
  scope: z.enum(["results", "all"]),
  status: z.enum(["queued", "running", "paused", "completed", "stopped", "failed"]),
  stage: z.string().max(500),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  scanned: z.number().int().nonnegative(),
  phase: z.enum(["capture", "analysis"]),
  analyzed: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative().nullable(),
  sort: z.string().nullable(),
  currentFrame: z.string().nullable(),
  lastFingerprint: z.string().nullable(),
  apiUsage: z.object({
    input: z.number(),
    output: z.number(),
    requests: z.number(),
    cached: z.number(),
    navigationRequests: z.number(),
    dataRequests: z.number(),
  }),
  error: z.string().nullable(),
  checkpointRequired: z.boolean(),
  iphoneUseVersion: z.string().nullable(),
});
export type Scan = z.infer<typeof scanSchema>;
export type ScanStatus = Scan["status"];
export const scanItemSchema = z.object({
  id: z.string().max(100),
  scanId: z.string().max(100),
  position: z.number().int().nonnegative(),
  frame: frameSchema,
  appraisalFrame: frameSchema,
  movesFrame: frameSchema,
  measuredIV: ivMeasuredSchema,
  fingerprint: z.string(),
  pokemonId: z.string().nullable(),
  fields: fieldsSchema.nullable(),
  issues: z.array(z.string()),
  protectionClear: z.boolean(),
  favoriteRechecked: z.boolean().optional(),
  evolutionSilhouette: evolutionSilhouetteSchema.optional(),
  maxStatus: maxStatusSchema.optional(),
  shinyReview: z
    .object({
      verdict: z.enum(["normal", "shiny", "uncertain"]),
      model: z.string().max(100),
      reason: z.string().max(500),
      referenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(2).optional(),
      reviewedAt: z.string().datetime(),
    })
    .optional(),
  specialReview: z
    .object({
      verdict: z.enum(["normal", "shadow", "purified", "uncertain"]),
      model: z.string().max(100),
      reason: z.string().max(400),
      reviewedAt: z.string().datetime(),
    })
    .optional(),
  capturedAt: z.string().datetime(),
  analyzedAt: z.string().datetime().optional(),
});
export type ScanItem = z.infer<typeof scanItemSchema>;
const transferEntrySchema = z.object({
  pokemonId: z.string(),
  status: z.enum([
    "pending",
    "searching",
    "unfavoriting",
    "prepared",
    "sent",
    "submitted",
    "confirmed",
    "skipped",
    "uncertain",
  ]),
  reason: z.string().nullable(),
  preparedAt: z.string().optional(),
  sentAt: z.string().optional(),
  submittedAt: z.string().optional(),
  confirmedAt: z.string().optional(),
  evidence: z.string().optional(),
});
export type TransferEntry = z.infer<typeof transferEntrySchema>;
export const transferBatchSchema = z.object({
  id: z.string().max(100),
  scanId: z.string().max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(["draft", "approved", "running", "paused", "completed", "stopped", "stale"]),
  mode: z.enum(["single", "bulk"]),
  searchExclusions: z
    .array(
      z.enum(
        transferSearchFilters.map((filter) => filter.id) as [
          TransferSearchFilter,
          ...TransferSearchFilter[],
        ],
      ),
    )
    .max(maxTransferSearchFilters)
    .optional(),
  selectedPokemonId: z.string().nullable(),
  needsBoxReturn: z.boolean().optional(),
  signature: z.string(),
  entries: z.array(transferEntrySchema),
  error: z.string().nullable(),
  approvedAt: z.string().nullable(),
  hiddenAt: z.string().nullable().optional(),
});
export type TransferBatch = z.infer<typeof transferBatchSchema>;
