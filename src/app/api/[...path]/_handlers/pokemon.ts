import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  get,
  getSnapshot,
  listPokemon,
  now,
  put,
  remove,
  transaction,
} from "@/lib/store";
import { effective, fieldsSchema, type Pokemon } from "@/lib/types";
import { reevaluate } from "@/lib/evaluate";
import { clearPokemonData } from "@/lib/clear-pokemon-data";
import { body, json } from "./http";

const editInput = z
  .object({
    fields: fieldsSchema.partial().optional(),
    verified: z.boolean().optional(),
    locked: z.boolean().optional(),
    owned: z.boolean().optional(),
    evolutionSilhouette: z.union([z.boolean(), z.literal("unavailable"), z.literal("unknown-branch")]).nullable().optional(),
    maxStatus: z.enum(["none", "dynamax", "gigantamax"]).nullable().optional(),
    dismissCandidates: z.boolean().optional(),
  })
  .strict();
const mergeInput = z.object({ target: z.string(), source: z.string() });
const clearAllInput = z.object({
  confirmation: z.literal("清除全部寶可夢"),
}).strict();

export async function updatePokemon(req: NextRequest, id: string) {
  const record = get<Pokemon>("pokemon", id);
  if (!record) return json({ error: "找不到個體" }, 404);
  const input = editInput.parse(await body(req));
  return json(applyEdit(record, input));
}
export async function merge(req: NextRequest) {
  const input = mergeInput.parse(await body(req));
  return json(mergePokemon(input.target, input.source));
}
export async function clearAll(req: NextRequest) {
  clearAllInput.parse(await body(req));
  return json(clearPokemonData());
}
export function reevaluateAll() {
  reevaluate();
  return json({ ok: true });
}
function applyEdit(record: Pokemon, input: z.infer<typeof editInput>) {
  const next = {
    ...record,
    overrides: { ...record.overrides, ...input.fields },
    verified: input.verified ?? (input.fields ? false : record.verified),
    verification:
      input.verified === true
        ? ("human" as const)
        : input.verified === false || input.fields
          ? null
          : record.verification,
    locked: input.locked ?? record.locked,
    owned: input.owned ?? record.owned,
    evolutionSilhouette:
      input.evolutionSilhouette === undefined
        ? record.evolutionSilhouette
        : input.evolutionSilhouette,
    maxStatus:
      input.maxStatus === undefined ? record.maxStatus : input.maxStatus,
    updatedAt: now(),
  };
  const merged = effective(next);
  if (merged.speciesId && !getSnapshot()?.species[merged.speciesId])
    throw new Error("物種 ID 不存在於目前資料快照");
  if (merged.shadow && merged.purified)
    throw new Error("不能同時為暗影與淨化");
  if (
    merged.speciesId &&
    merged.shadow !== null &&
    Boolean(
      getSnapshot()?.species[merged.speciesId]?.tags.includes("shadow"),
    ) !== merged.shadow
  )
    throw new Error("暗影狀態與所選物種不一致，請選擇對應的一般／暗影形態。");
  if (input.dismissCandidates || input.owned === false) {
    const peers = next.candidates;
    next.candidates = [];
    for (const peerId of peers) {
      const peer = get<Pokemon>("pokemon", peerId);
      if (peer)
        put("pokemon", peer.id, {
          ...peer,
          candidates: peer.candidates.filter((p) => p !== next.id),
        });
    }
  }
  put("pokemon", next.id, next);
  reevaluate();
  return get<Pokemon>("pokemon", next.id);
}
function mergePokemon(target: string, source: string) {
  if (target === source) throw new Error("不能與自己合併");
  const a = get<Pokemon>("pokemon", target),
    b = get<Pokemon>("pokemon", source);
  if (!a || !b) throw new Error("找不到要合併的個體");
  const fields = { ...a.fields },
    issues = [...a.issues, ...b.issues],
    overrides = { ...b.overrides, ...a.overrides };
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (fields[key] === null)
      (fields as Record<string, unknown>)[key] = b.fields[key];
    else if (b.fields[key] !== null && fields[key] !== b.fields[key])
      issues.push(`合併後請核對衝突欄位：${key}`);
  }
  const maxConflict = a.maxStatus != null && b.maxStatus != null &&
    a.maxStatus !== b.maxStatus;
  if (maxConflict) issues.push("合併後請核對極巨化狀態衝突");
  const joined: Pokemon = {
    ...a,
    fields,
    overrides,
    maxStatus: maxConflict ? null : a.maxStatus ?? b.maxStatus ?? null,
    issues: [...new Set(issues)],
    sources: [...a.sources, ...b.sources],
    locked: a.locked || b.locked,
    verified: false,
    verification: null,
    candidates: [...new Set([...a.candidates, ...b.candidates])].filter(
      (x) => x !== a.id && x !== b.id,
    ),
    updatedAt: now(),
  };
  transaction(() => {
    put("pokemon", a.id, joined);
    remove("pokemon", b.id);
    for (const peer of listPokemon()) {
      if (peer.id !== a.id && peer.candidates.includes(b.id))
        put("pokemon", peer.id, {
          ...peer,
          candidates: [
            ...new Set(peer.candidates.map((k) => (k === b.id ? a.id : k))),
          ].filter((k) => k !== peer.id),
        });
    }
  });
  reevaluate();
  return get<Pokemon>("pokemon", a.id);
}
