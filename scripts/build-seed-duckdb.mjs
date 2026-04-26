#!/usr/bin/env node
// Rebuild assets/seed/workspace.duckdb from assets/seed/schema.sql.
//
// Why this exists:
//   The shipped seed DB was previously a hand-built artifact that drifted from
//   schema.sql every time the schema gained new objects (email_thread,
//   email_message, calendar_event, interaction, ...). New workspaces ended up
//   with an outdated DB that ensureLatestSchema() then had to migrate at
//   runtime. Wiring this script into `prepack` keeps the shipped seed in lock-
//   step with schema.sql so fresh sandboxes start with the full, current
//   schema.
//
// Requirements:
//   The duckdb CLI must be available on PATH (`which duckdb`). On CI install
//   via `curl -fsSL https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip`
//   then unzip, on dev machines via `brew install duckdb`. The sandbox
//   Dockerfile already installs it for runtime use.

import { execFileSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const SEED_DIR = join(ROOT_DIR, "assets", "seed");
const SCHEMA_SQL = join(SEED_DIR, "schema.sql");
const SEED_DB = join(SEED_DIR, "workspace.duckdb");

function die(msg) {
  console.error(`build-seed-duckdb: ${msg}`);
  process.exit(1);
}

if (!existsSync(SCHEMA_SQL)) {
  die(`schema source missing at ${SCHEMA_SQL}`);
}

try {
  execFileSync("duckdb", ["--version"], { stdio: "ignore" });
} catch {
  die(
    "duckdb CLI not found on PATH. Install with `brew install duckdb` (macOS) or " +
      "https://github.com/duckdb/duckdb/releases (other). The sandbox Dockerfile " +
      "already installs it; this prepack step needs it on whatever host runs `pnpm pack`.",
  );
}

if (existsSync(SEED_DB)) {
  unlinkSync(SEED_DB);
}

console.log(`build-seed-duckdb: rebuilding ${SEED_DB} from ${SCHEMA_SQL}`);

try {
  execFileSync("duckdb", [SEED_DB], {
    input: `.read ${SCHEMA_SQL}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
} catch (err) {
  die(
    `duckdb failed while running schema.sql: ${err instanceof Error ? err.message : String(err)}`,
  );
}

if (!existsSync(SEED_DB)) {
  die("duckdb finished but no workspace.duckdb was produced");
}

const stats = statSync(SEED_DB);
if (stats.size < 1024) {
  die(
    `workspace.duckdb suspiciously small (${stats.size} bytes) — schema.sql may not have executed`,
  );
}

// Sanity check: confirm the `objects` table exists and has the seeded rows.
let objectCountRaw;
try {
  objectCountRaw = execFileSync(
    "duckdb",
    [SEED_DB, "-noheader", "-list", "SELECT COUNT(*) FROM objects"],
    {
      encoding: "utf-8",
    },
  ).trim();
} catch (err) {
  die(`could not query the seeded DB: ${err instanceof Error ? err.message : String(err)}`);
}

const objectCount = Number.parseInt(objectCountRaw, 10);
if (!Number.isFinite(objectCount) || objectCount < 3) {
  die(`expected at least 3 objects in seeded DB, got ${JSON.stringify(objectCountRaw)}`);
}

console.log(
  `build-seed-duckdb: seeded ${SEED_DB} (${stats.size.toLocaleString()} bytes, ${objectCount} objects)`,
);
