/**
 * scripts/cleanup_memory_facts.ts
 *
 * Owner-approved cleanup of known test-fixture memories.
 *
 * Safety:
 * - Default mode is dry-run: it only SELECTs and prints.
 * - --apply is required to delete anything.
 * - --local targets the local Miniflare D1; default is --remote.
 * - Backup first:
 *     npx wrangler d1 export personal-ai-os-db --remote --output=backups/<file>.sql
 *
 * Usage:
 *   npx tsx scripts/cleanup_memory_facts.ts --dry-run --remote
 *   npx tsx scripts/cleanup_memory_facts.ts --apply --remote
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DB_NAME = "personal-ai-os-db";
const TARGET_IDS = [
  "mem_MW63VEK50R13ODPJ",
  "mem_m11_fake_time",
  "mem_m09_study",
  "mem_MW7XN1EOHJXSYGGH",
];

const ABOUT_ME_REWRITE =
  "Name: Doodam Yogi Jatin Sai (Yogi / Jatin / Yuki). Assistant: Daemon. Address as sir, boss, or master.";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const remote = !args.includes("--local");
const modeFlag = remote ? "--remote" : "--local";

function parseRows(output: string): any[] {
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
    return (rows || []).filter((row: any) => row && Object.keys(row).length > 0);
  } catch {
    return [];
  }
}

/** Schema/read queries use --command: --file JSON has a different wrapper shape. */
function queryJson(sql: string): any[] {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute ${DB_NAME} ${modeFlag} --json --command="${escaped}"`;
  const output = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return parseRows(output);
}

function executeFile(sql: string): string {
  const tmpFile = path.join(os.tmpdir(), `daemon-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, "utf8");
  try {
    const cmd = `npx wrangler d1 execute ${DB_NAME} ${modeFlag} --file="${tmpFile}"`;
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

const idList = TARGET_IDS.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
const selectSql = `SELECT id, canonical_text, created_at, deleted_at FROM memory_objects WHERE id IN (${idList}) OR id LIKE 'mem_m%fake%' ORDER BY id;`;
const settingsSql = `SELECT key, value, updated_at FROM settings WHERE key = 'about_me_summary';`;

console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"} (${remote ? "remote" : "local"})`);

console.log("\n--- matching memory_objects rows ---");
const rows = queryJson(selectSql);
if (rows.length === 0) {
  console.log("(none)");
} else {
  for (const row of rows) {
    console.log(`${row.id} | deleted_at=${row.deleted_at ?? "NULL"} | created=${row.created_at ?? "?"} | ${row.canonical_text}`);
  }
}

console.log("\n--- current about_me_summary ---");
const settingsRows = queryJson(settingsSql);
console.log(settingsRows[0]?.value ?? "(not set)");

console.log("\n--- about_me_summary after rewrite ---");
console.log(ABOUT_ME_REWRITE);

if (!apply) {
  console.log("\nDry run only. Re-run with --apply to delete the printed rows and rewrite about_me_summary.");
  process.exit(0);
}

const applySql = `DELETE FROM memory_objects WHERE id IN (${idList});
DELETE FROM memory_objects WHERE id LIKE 'mem_m%fake%';
INSERT OR REPLACE INTO settings (key, value, updated_at)
VALUES ('about_me_summary', '${ABOUT_ME_REWRITE.replace(/'/g, "''")}', datetime('now'));`;

console.log("\n--- applying cleanup ---");
console.log(executeFile(applySql).slice(0, 2000));

console.log("\n--- verification: remaining rows ---");
const remaining = queryJson(selectSql);
console.log(remaining.length === 0 ? "(none)" : JSON.stringify(remaining, null, 2));

console.log("\n--- verification: about_me_summary ---");
const afterRows = queryJson(settingsSql);
console.log(afterRows[0]?.value ?? "(not set)");
