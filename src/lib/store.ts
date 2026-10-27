import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaultSettings,
  type Observation,
  type Pokemon,
  type Settings,
  type Snapshot,
} from "./types";

export const dataDir = path.resolve(
  /* turbopackIgnore: true */ (globalThis as typeof globalThis & { __POGO_TEST_DATA_DIR__?: string }).__POGO_TEST_DATA_DIR__ ||
    path.join(process.cwd(), ".data"),
);
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
const globalDb = globalThis as unknown as { pogoDb?: DatabaseSync };
export function db() {
  if (!globalDb.pogoDb) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    const d = new DatabaseSync(path.join(dataDir, "collection.sqlite"));
    fs.chmodSync(path.join(dataDir, "collection.sqlite"), 0o600);
    d.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    for (const table of [
      "observations",
      "pokemon",
      "settings",
      "snapshots",
      "vision_cache",
      "scans",
      "scan_items",
      "transfer_batches",
    ])
      d.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
      );
    globalDb.pogoDb = d;
  }
  return globalDb.pogoDb;
}
type Table =
  | "observations"
  | "pokemon"
  | "settings"
  | "snapshots"
  | "vision_cache"
  | "scans"
  | "scan_items"
  | "transfer_batches";
export function get<T>(table: Table, key: string): T | null {
  const row = db().prepare(`SELECT data FROM ${table} WHERE id=?`).get(key) as
    { data: string } | undefined;
  return row ? (JSON.parse(row.data) as T) : null;
}
export function all<T>(table: Table): T[] {
  return (
    db().prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as {
      data: string;
    }[]
  ).map((r) => JSON.parse(r.data));
}
export function put(table: Table, key: string, value: unknown) {
  db()
    .prepare(
      `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
    )
    .run(key, JSON.stringify(value));
}
export function remove(table: Table, key: string) {
  db().prepare(`DELETE FROM ${table} WHERE id=?`).run(key);
}
export function transaction<T>(fn: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db().exec("COMMIT");
    return value;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}
export const listPokemon = () => all<Pokemon>("pokemon");
export const listObservations = (jobId: string) =>
  all<Observation>("observations").filter((o) => o.jobId === jobId);
export const getSettings = () =>
  get<Settings>("settings", "preferences") || defaultSettings;
export function getSnapshot(): Snapshot | null {
  const current = get<{ version: string }>("settings", "snapshot");
  return current ? get<Snapshot>("snapshots", current.version) : null;
}
export function saveSnapshot(snapshot: Snapshot) {
  transaction(() => {
    put("snapshots", snapshot.version, snapshot);
    put("settings", "snapshot", { version: snapshot.version });
  });
}
