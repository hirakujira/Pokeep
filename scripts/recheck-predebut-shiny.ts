import path from "node:path";
import { inferLevels, reevaluate } from "../src/lib/evaluate";
import { automaticVerification } from "../src/lib/iphone-safety";
import { readLocalOcr } from "../src/lib/local-ocr";
import { caughtDateBadge } from "../src/lib/shiny-timeline";
import { dataDir, get, getSnapshot, now, put, transaction } from "../src/lib/store";
import { updateScan } from "../src/lib/iphone-data";
import type { Scan, ScanItem } from "../src/lib/iphone-types";
import type { Observation, Pokemon } from "../src/lib/types";

// West and East Sea Shellos Shiny debuted at GO Fest 2023 Global.
// https://leekduck.com/events/pokemon-go-fest-2023-global/
const shinyDebut: Record<string, string> = { shellos: "2023-08-26" };

const pokemonId = process.argv[2];
if (!pokemonId) throw new Error("請指定個體 ID");
const pokemon = get<Pokemon>("pokemon", pokemonId);
if (
  !pokemon ||
  !pokemon.owned ||
  pokemon.verified ||
  pokemon.verification === "human" ||
  pokemon.fields.shiny !== null ||
  pokemon.issues.length ||
  pokemon.candidates.length ||
  Object.keys(pokemon.overrides).length
)
  throw new Error("個體不符合安全的色違重核對條件");
const debut = pokemon.fields.speciesId && shinyDebut[pokemon.fields.speciesId];
const scan = get<Scan>("scans", pokemon.jobId);
const snapshot = getSnapshot();
const species = pokemon.fields.speciesId && snapshot?.species[pokemon.fields.speciesId];
const itemId = pokemon.sources.find((source) => source.scanItemId)?.scanItemId;
const item = itemId ? get<ScanItem>("scan_items", itemId) : null;
if (
  !debut ||
  !species ||
  !scan ||
  scan.status !== "completed" ||
  !snapshot ||
  !item ||
  item.pokemonId !== pokemon.id ||
  !item.protectionClear ||
  !item.appraisalFrame ||
  item.shinyReview?.verdict !== "uncertain"
)
  throw new Error("缺少符合條件的物種、掃描或色違複核紀錄");
const top = get<Observation>(
  "observations",
  `${scan.id}-${item.position}-0`,
);
const appraisal = get<Observation>(
  "observations",
  `${scan.id}-${item.position}-2`,
);
if (
  !top ||
  !appraisal ||
  top.frame !== item.frame ||
  appraisal.frame !== item.appraisalFrame ||
  top.segment !== item.id ||
  appraisal.segment !== item.id ||
  top.fields.name !== appraisal.fields.name ||
  top.fields.cp !== appraisal.fields.cp
)
  throw new Error("能力頁與評價頁來源不一致");
const paths = [top.frame, appraisal.frame].map((frame) =>
  path.join(dataDir, "frames", frame),
);
const [topLines, appraisalLines] = await readLocalOcr(paths);
const captured = caughtDateBadge(topLines);
if (!captured || captured !== caughtDateBadge(appraisalLines) || captured >= debut)
  throw new Error("兩張截圖未一致顯示早於色違推出的捕獲日期");
const fields = { ...pokemon.fields, shiny: false };
if (
  !automaticVerification({
    fields,
    top: top.fields,
    appraisal: appraisal.fields,
    measuredIV: item.measuredIV || null,
    levels: inferLevels(species, fields, snapshot),
    clear: true,
    issues: [],
    costumeAbsentClear: true,
    warningVisible: false,
  })
)
  throw new Error("色違排除後仍缺少完整的自動核對證據");
transaction(() => {
  put("pokemon", pokemon.id, {
    ...pokemon,
    fields,
    verified: true,
    verification: "automatic",
    updatedAt: now(),
  });
  put("scan_items", item.id, {
    ...item,
    fields,
    shinyReview: {
      verdict: "normal",
      model: "local-ocr-release-timeline",
      reason: `能力與評價頁均顯示 ${captured} 捕獲，早於此物種色違推出日 ${debut}；原配色複核不確定，依時間證據排除色違。`,
      reviewedAt: now(),
    },
  });
  updateScan(scan.id, { review: Math.max(0, scan.review - 1) });
});
reevaluate();
console.log(`${pokemon.fields.name} CP ${pokemon.fields.cp}：${captured} 早於 ${debut}，色違=false；已自動核對`);
// The local OCR process otherwise keeps this one-shot maintenance command alive.
process.exit(0);
