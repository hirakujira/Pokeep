import type { NextRequest } from "next/server";
import { askAi } from "@/lib/ask-ai";
import { body, json } from "./http";

export async function ask(req: NextRequest) {
  return json({ answer: await askAi(await body(req)) });
}
