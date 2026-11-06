import crypto from "node:crypto";
import { execSync } from "node:child_process";

async function main() {
  const rawToken = "failover_test_token_" + crypto.randomBytes(16).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const sessionId = "failover-sess-" + crypto.randomBytes(8).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  console.log("1. Inserting temporary auth session in remote D1...");
  const sqlInsert = `INSERT INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('${sessionId}', '${tokenHash}', '8364430714', 'default', '${expiresAt}', '${nowIso}', '${nowIso}');`;
  execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlInsert}"`, { stdio: "inherit" });

  try {
    console.log("\n2. Calling POST /api/v1/ai/suggest_next (Groq disabled in config)...");
    const res = await fetch("https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/ai/suggest_next", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawToken}`,
      },
      body: JSON.stringify({
        privacy_class: "personal",
        query: "What should I work on next?",
      }),
    });

    console.log(`Status: HTTP ${res.status}`);
    const json = await res.json();
    console.log("Failover Execution Response:\n", JSON.stringify(json, null, 2));
  } finally {
    console.log("\n3. Cleaning up temporary session from remote D1...");
    const sqlDelete = `DELETE FROM auth_sessions WHERE id = '${sessionId}';`;
    execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlDelete}"`, { stdio: "inherit" });
  }
}

main().catch(console.error);
