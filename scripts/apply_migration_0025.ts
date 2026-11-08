/**
 * scripts/apply_migration_0025.ts
 *
 * Applies migrations/0025_memory_actions.sql to a database whose schema may
 * already contain some of the columns (production drift). SQLite cannot do
 * "ADD COLUMN IF NOT EXISTS", so this script:
 *   1. reads PRAGMA table_info for memory_objects and mirror_outbox,
 *   2. builds a tailored SQL file with only the missing ALTERs,
 *   3. runs the CREATE TABLE / CREATE INDEX statements (all IF NOT EXISTS),
 *   4. executes once with wrangler d1 execute,
 *   5. re-reads PRAGMA to prove the final shape.
 *
 * Usage: npx tsx scripts/apply_migration_0025.ts [--local]
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DB_NAME = "personal-ai-os-db";
const remote = !process.argv.includes("--local");
const modeFlag = remote ? "--remote" : "--local";

function execute(sql: string, json: boolean): string {
  const tmpFile = path.join(os.tmpdir(), `daemon-0025-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, "utf8");
  try {
    const cmd = `npx wrangler d1 execute ${DB_NAME} ${modeFlag} --file="${tmpFile}"${json ? " --json" : ""}`;
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

function tableColumns(table: string): string[] {
  // Schema reads must use --command: wrangler's --file/--json wrapper differs
  // from the plain array shape returned by --command.
  const cmd = `npx wrangler d1 execute ${DB_NAME} ${modeFlag} --json --command="PRAGMA table_info(${table});"`;
  const output = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(output.slice(start, end + 1));
    const rows = Array.isArray(parsed)
      ? Array.isArray(parsed[0]?.results)
        ? parsed[0].results
        : parsed
      : Array.isArray(parsed?.results)
        ? parsed.results
        : [];
    return (rows || [])
      .map((row: any) => String(row?.name || ""))
      .filter((name: string) => name.length > 0);
  } catch {
    return [];
  }
}

const memoryColumns = tableColumns("memory_objects");
if (memoryColumns.length === 0 || !memoryColumns.includes("id")) {
  console.error("memory_objects schema unreadable (no 'id' column). Aborting without changes.");
  process.exit(1);
}
const mirrorColumns = tableColumns("mirror_outbox");

const memoryAdditions: Array<[string, string]> = [
  ["trust", "ALTER TABLE memory_objects ADD COLUMN trust TEXT NOT NULL DEFAULT 'high';"],
  ["sensitivity", "ALTER TABLE memory_objects ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal';"],
  ["expires_at", "ALTER TABLE memory_objects ADD COLUMN expires_at TEXT;"],
  ["last_used_at", "ALTER TABLE memory_objects ADD COLUMN last_used_at TEXT;"],
  ["deleted_at", "ALTER TABLE memory_objects ADD COLUMN deleted_at TEXT;"],
];

const statements: string[] = [];
statements.push(`CREATE TABLE IF NOT EXISTS memory_proposals (
  id              TEXT PRIMARY KEY,
  canonical_text  TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'telegram_ai_suggested',
  trust           TEXT NOT NULL DEFAULT 'medium',
  sensitivity     TEXT NOT NULL DEFAULT 'normal',
  status          TEXT NOT NULL DEFAULT 'pending',
  replaces_id     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);`);
statements.push("CREATE INDEX IF NOT EXISTS idx_memory_proposals_status ON memory_proposals(status);");

for (const [column, statement] of memoryAdditions) {
  if (!memoryColumns.includes(column)) statements.push(statement);
}
statements.push("CREATE INDEX IF NOT EXISTS idx_memory_objects_deleted ON memory_objects(deleted_at);");

if (mirrorColumns.length > 0 && !mirrorColumns.includes("action")) {
  statements.push("ALTER TABLE mirror_outbox ADD COLUMN action TEXT NOT NULL DEFAULT 'upsert';");
}
if (mirrorColumns.length > 0) {
  statements.push("CREATE INDEX IF NOT EXISTS idx_mirror_outbox_action ON mirror_outbox(action);");
}

console.log(`Target: ${remote ? "remote" : "local"} ${DB_NAME}`);
console.log(`Existing memory_objects columns: ${memoryColumns.join(", ")}`);
console.log(`Existing mirror_outbox columns: ${mirrorColumns.join(", ") || "(table missing)"}`);
console.log("\nStatements to apply:");
for (const statement of statements) console.log(`  - ${statement.split("\n")[0]}...`);

execute(statements.join("\n"), false);

const afterMemory = tableColumns("memory_objects");
const afterMirror = tableColumns("mirror_outbox");
console.log("\nAfter migration:");
console.log(`  memory_objects: ${afterMemory.join(", ")}`);
console.log(`  mirror_outbox: ${afterMirror.join(", ")}`);

const required = ["trust", "sensitivity", "expires_at", "last_used_at", "deleted_at"];
const missing = required.filter((column) => !afterMemory.includes(column));
if (missing.length > 0) {
  console.error(`FAILED: missing columns after migration: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("\nMigration 0025 applied and verified.");
