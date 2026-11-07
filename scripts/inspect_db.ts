import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

const ROOT_DIR = process.cwd();

async function main() {
  const rawToken = "golden_test_token_" + crypto.randomBytes(16).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const sessionId = "golden-sess-" + crypto.randomBytes(8).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const nowIso = new Date().toISOString();

  const tempSql = path.resolve(ROOT_DIR, ".tmp_sess.sql");
  fs.writeFileSync(
    tempSql,
    `INSERT INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('${sessionId}', '${tokenHash}', '8364430714', 'default', '${expiresAt}', '${nowIso}', '${nowIso}');`,
    "utf8"
  );
  execSync(`npx wrangler d1 execute personal-ai-os-db --remote --file="${tempSql}"`, { stdio: "ignore" });
  try { fs.unlinkSync(tempSql); } catch {}

  const res = await fetch("https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/internal/test/d1-query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${rawToken}`,
    },
    body: JSON.stringify({ sql: "SELECT key, value FROM settings;" }),
  });

  const json = await res.json();
  console.log("Settings:", JSON.stringify(json.results, null, 2));

  await fetch("https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/internal/test/d1-query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
    body: JSON.stringify({
      sql: `INSERT OR REPLACE INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
            VALUES ('sem_fall_2026', 'Fall 2026', '2026-08-01', '2026-12-31', 1, datetime('now'), datetime('now'));`
    }),
  });

  const resetRes = await fetch("https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/internal/test/d1-query", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
    body: JSON.stringify({ sql: "DELETE FROM provider_health;" }),
  });
  console.log("Reset provider_health:", await resetRes.json());

  fs.writeFileSync(tempSql, `DELETE FROM auth_sessions WHERE id = '${sessionId}';`, "utf8");
  execSync(`npx wrangler d1 execute personal-ai-os-db --remote --file="${tempSql}"`, { stdio: "ignore" });
  try { fs.unlinkSync(tempSql); } catch {}
}

main().catch(console.error);
