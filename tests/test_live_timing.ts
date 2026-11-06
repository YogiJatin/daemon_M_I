import crypto from "node:crypto";
import { execSync } from "node:child_process";

async function main() {
  const rawToken = "timing_test_token_" + crypto.randomBytes(16).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const sessionId = "timing-sess-" + crypto.randomBytes(8).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  console.log("1. Inserting temporary auth session in remote D1...");
  const sqlInsert = `INSERT INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('${sessionId}', '${tokenHash}', '8364430714', 'default', '${expiresAt}', '${nowIso}', '${nowIso}');`;
  execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlInsert}"`, { stdio: "inherit" });

  try {
    const updateId = Math.floor(Math.random() * 1000000) + 200000;
    console.log(`\n2. Sending '/add test in 2 minutes' to deployed webhook at ${now.toISOString()}...`);
    const res = await fetch("https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawToken}`,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: {
          message_id: updateId,
          from: { id: 8364430714, is_bot: false, first_name: "Owner" },
          chat: { id: 8364430714, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/add test in 2 minutes",
        },
      }),
    });

    console.log(`Webhook HTTP ${res.status}`);
    const json = await res.json();
    console.log("Webhook Response:\n", JSON.stringify(json, null, 2));

    const taskId = json.taskId;
    console.log("\n3. Querying task and notification_log for taskId:", taskId);
    if (taskId) {
      const sqlQuery = `SELECT t.id, t.title, t.deadline_utc_instant, n.id as notif_id, n.scheduled_at, n.status, n.sent_at FROM tasks t LEFT JOIN notification_log n ON n.task_id = t.id WHERE t.id = '${taskId}';`;
      execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlQuery}"`, { stdio: "inherit" });
    }
  } finally {
    console.log("\n4. Cleaning up temporary session from remote D1...");
    const sqlDelete = `DELETE FROM auth_sessions WHERE id = '${sessionId}';`;
    execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlDelete}"`, { stdio: "inherit" });
  }
}

main().catch(console.error);
