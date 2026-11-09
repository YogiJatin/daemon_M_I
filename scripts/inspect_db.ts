/**
 * scripts/inspect_db.ts - small debug helper for the settings/timetable tables.
 *
 * Defaults to the local Worker (wrangler dev). It writes a throwaway auth session
 * and clears provider_health, so it must never reach production by accident:
 * an explicit --allow-remote (or ALLOW_REMOTE_TESTS=1) is required.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { assertSafeTarget, parseTarget } from "./lib/testGuard";

const ROOT_DIR = process.cwd();
const TEST_TARGET = parseTarget();
assertSafeTarget("inspect_db", TEST_TARGET);
const BASE_URL = TEST_TARGET.baseUrl;

const rawToken = "golden_test_token_" + crypto.randomBytes(16).toString("hex");
const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
const sessionId = "golden-sess-" + crypto.randomBytes(8).toString("hex");
const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const nowIso = new Date().toISOString();

const tempSql = path.resolve(ROOT_DIR, ".tmp_sess.sql");

function seedSession(): void {
  fs.writeFileSync(
    tempSql,
    `INSERT INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('${sessionId}', '${tokenHash}', '8364430714', 'default', '${expiresAt}', '${nowIso}', '${nowIso}');`,
    "utf8"
  );
  execSync(`npx wrangler d1 execute personal-ai-os-db ${TEST_TARGET.d1Flag} --file="${tempSql}"`, { stdio: "ignore" });
  try { fs.unlinkSync(tempSql); } catch {}
}

function dropSession(): void {
  fs.writeFileSync(tempSql, `DELETE FROM auth_sessions WHERE id = '${sessionId}';`, "utf8");
  execSync(`npx wrangler d1 execute personal-ai-os-db ${TEST_TARGET.d1Flag} --file="${tempSql}"`, { stdio: "ignore" });
  try { fs.unlinkSync(tempSql); } catch {}
}

async function query(sql: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/v1/internal/test/d1-query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
    body: JSON.stringify({ sql }),
  });
  return res.json();
}

async function main(): Promise<void> {
  seedSession();
  try {
    console.log("Settings:", JSON.stringify(await query("SELECT key, value FROM settings;"), null, 2));

    await query(`INSERT OR REPLACE INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
            VALUES ('sem_fall_2026', 'Fall 2026', '2026-08-01', '2026-12-31', 1, datetime('now'), datetime('now'));`);

    console.log("Reset provider_health:", await query("DELETE FROM provider_health;"));
  } finally {
    dropSession();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
