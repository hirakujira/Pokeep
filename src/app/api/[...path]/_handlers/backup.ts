import type { NextRequest } from "next/server";
import { exportBackup, exportCsv, importBackup } from "@/lib/backup";
import { body, json } from "./http";

export async function exportData(req: NextRequest) {
  const csv = req.nextUrl.searchParams.get("format") === "csv";
  return new Response(
    csv ? exportCsv() : JSON.stringify(await exportBackup()),
    {
      headers: {
        "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json",
        "Content-Disposition": `attachment; filename="pokemon-go-${new Date().toISOString().slice(0, 10)}.${csv ? "csv" : "json"}"`,
        "Cache-Control": "no-store",
      },
    },
  );
}
export async function importData(req: NextRequest) {
  return json(await importBackup(await body(req, 150 * 1024 * 1024)));
}
