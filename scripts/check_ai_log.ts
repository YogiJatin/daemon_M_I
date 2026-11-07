import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

const ROOT_DIR = process.cwd();
const DEPLOYED_URL = "https://personal-ai-os.jatin-personal-ai.workers.dev";

async function run() {
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

  const res = await fetch(`${DEPLOYED_URL}/api/v1/internal/test/gemini-probe`, {
    headers: { Authorization: "Bearer " + rawToken }
  });
  console.log("PROBE STATUS:", res.status);
  console.log(await res.text());

  // cleanup session
  fs.writeFileSync(tempSql, `DELETE FROM auth_sessions WHERE id = '${sessionId}';`, "utf8");
  execSync(`npx wrangler d1 execute personal-ai-os-db --remote --file="${tempSql}"`, { stdio: "ignore" });
  try { fs.unlinkSync(tempSql); } catch {}
}
run();
