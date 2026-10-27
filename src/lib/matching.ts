import type { Fields } from "./types";

const identityKeys = [
  "cp",
  "hp",
  "gender",
  "height",
  "weight",
  "shadow",
  "purified",
  "shiny",
  "costume",
] as const;
export function matching(
  a: Fields,
  b: Fields,
): "exact" | "possible" | "different" {
  if (!a.speciesId || !b.speciesId || a.speciesId !== b.speciesId)
    return "different";
  if (a.form !== null && b.form !== null && a.form !== b.form)
    return "different";
  let strong = 0;
  for (const key of identityKeys) {
    if (a[key] !== null && b[key] !== null) {
      if (a[key] !== b[key]) return "different";
      if (["cp", "hp", "gender", "height", "weight"].includes(key)) strong++;
    }
  }
  for (const key of ["ivAtk", "ivDef", "ivSta"] as const)
    if (a[key] !== null && b[key] !== null && a[key] !== b[key])
      return "different";
  return strong === 5 ? "exact" : "possible";
}
