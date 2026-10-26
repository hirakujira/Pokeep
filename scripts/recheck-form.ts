import fs from "node:fs";
import path from "node:path";
import { reevaluate } from "../src/lib/evaluate";
import { updateScan } from "../src/lib/iphone-data";
import { displayForm, uniqueFormFromStats } from "../src/lib/iphone-form";
import { automaticVerification } from "../src/lib/iphone-safety";
import { dataDir, get, getSnapshot, now, put, transaction } from "../src/lib/store";
import type { Scan, ScanItem } from "../src/lib/iphone-types";
import type { Observation, Pokemon } from "../src/lib/types";

const pokemonId = process.argv[2];
if (!pokemonId) throw new Error("請指定個體 ID");
const pokemon = get<Pokemon>("pokemon", pokemonId);
if (
  !pokemon ||
  !pokemon.owned ||
  pokemon.verified ||
  pokemon.verification === "human" ||
  pokemon.issues.length ||
  pokemon.candidates.length ||
  Object.keys(pokemon.overrides).length
)
  throw new Error("這隻個體不符合自動形態修正條件");
const scan = get<Scan>("scans", pokemon.jobId);
const snapshot = getSnapshot();
if (!scan || scan.status !== "completed" || !snapshot)
  throw new Error("缺少已完成掃描或遊戲資料快照");
const item = get<ScanItem>(
  "scan_items",
  pokemon.sources.find((source) => source.scanItemId)?.scanItemId || "",
);
if (
  !item ||
  item.pokemonId !== pokemonId ||
  !item.protectionClear ||
  !item.movesFrame ||
  !item.appraisalFrame
)
  throw new Error("缺少完整且無警告的三張掃描畫面");
const frames = [item.frame, item.movesFrame, item.appraisalFrame];
const observations = [0, 1, 2].map((index) =>
  get<Observation>("observations", `${scan.id}-${item.position}-${index}`),
);
if (
  observations.some(
    (row, index) =>
      !row ||
      row.segment !== item.id ||
      row.frame !== frames[index] ||
      !fs.existsSync(path.join(dataDir, "frames", frames[index])),
  )
)
  throw new Error("掃描來源或檔案不完整");
const top = observations[0]!.fields;
const appraisal = observations[2]!.fields;
if (
  top.speciesId !== pokemon.fields.speciesId ||
  !top.name ||
  top.name !== appraisal.name ||
  top.cp === null ||
  top.cp !== appraisal.cp ||
  top.hp !== pokemon.fields.hp
)
  throw new Error("能力頁與評價頁身分資料不一致");
const candidate = uniqueFormFromStats(pokemon.fields, snapshot);
if (!candidate) throw new Error("CP、HP 與 IV 沒有對應唯一的其他形態");
const corrected = {
  ...pokemon.fields,
  speciesId: candidate.species.id,
  form: displayForm(candidate.species),
};
if (
  !automaticVerification({
    fields: corrected,
    top,
    appraisal,
    measuredIV: item.measuredIV || null,
    levels: [candidate.level],
    clear: true,
    issues: [],
    costumeAbsentClear: true,
    warningVisible: false,
  })
)
  throw new Error("修正形態後仍不符合自動核對條件");
transaction(() => {
  put("pokemon", pokemon.id, {
    ...pokemon,
    fields: corrected,
    verified: true,
    verification: "automatic",
    updatedAt: now(),
  });
  put("scan_items", item.id, { ...item, fields: corrected });
  updateScan(scan.id, { review: Math.max(0, scan.review - 1) });
});
reevaluate();
console.log(
  `${pokemon.fields.name} CP ${pokemon.fields.cp}: ${pokemon.fields.speciesId} → ${candidate.species.id}，等級 ${candidate.level}；已通過自動核對`,
);
