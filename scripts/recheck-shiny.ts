import { reviewUnknownShiny } from "../src/lib/iphone-scan";
import { get } from "../src/lib/store";
import type { Scan } from "../src/lib/iphone-types";

const scanId = process.argv[2];
if (!scanId) throw new Error("請提供已完成的掃描 ID");
const scan = get<Scan>("scans", scanId);
if (scan?.status !== "completed") throw new Error("只能重核對已完成的掃描");
const finished = await reviewUnknownShiny(scanId, true);
const updated = get<Scan>("scans", scanId);
console.log(JSON.stringify({ finished, review: updated?.review }));
