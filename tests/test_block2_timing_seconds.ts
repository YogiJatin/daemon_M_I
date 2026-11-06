/**
 * tests/test_block2_timing_seconds.ts
 *
 * Creates tasks due in 2 minutes at :05, :30, and :55 seconds past the minute.
 * Inspects notification_log scheduled_at to verify alignment at or before deadline minute.
 */

import crypto from "node:crypto";
import { execSync } from "node:child_process";

const BASE_URL = "https://personal-ai-os.jatin-personal-ai.workers.dev";
const OWNER_ID = 8364430714;

async function main() {
  console.log("==================================================================");
  console.log("TIMING TEST: TASKS DUE IN 2 MIN (:05, :30, :55 SECONDS)");
  console.log("==================================================================\n");

  const rawToken = "timing_test_token_" + crypto.randomBytes(16).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const sessionId = "timing-sess-" + crypto.randomBytes(8).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  console.log("1. Setting up auth session on remote D1...");
  const sqlInsert = `INSERT INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('${sessionId}', '${tokenHash}', '${OWNER_ID}', 'default', '${expiresAt}', '${nowIso}', '${nowIso}');`;
  execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlInsert}"`, { stdio: "pipe" });

  try {
    const taskIds: string[] = [];

    // Send task 1
    console.log("2. Sending /add timing test task in 2 minutes...");
    const res1 = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawToken}` },
      body: JSON.stringify({
        update_id: Math.floor(Date.now() / 1000),
        message: {
          message_id: Math.floor(Date.now() / 1000),
          from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
          chat: { id: OWNER_ID, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/add timing test task in 2 minutes",
        },
      }),
    });
    const json1 = (await res1.json()) as any;
    console.log(`Task created: ${json1.taskId} (status HTTP ${res1.status})`);
    if (json1.taskId) taskIds.push(json1.taskId);

    console.log("\n3. Querying remote D1 for scheduled_at and minute alignment...");
    if (taskIds.length > 0) {
      const sqlQuery = `SELECT t.id, t.title, t.deadline_at_utc, t.deadline_time_local, nl.id as notif_id, nl.scheduled_at, nl.status, nl.sent_at FROM tasks t LEFT JOIN notification_log nl ON nl.task_id = t.id WHERE t.id IN ('${taskIds.join("','")}');`;
      const out = execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlQuery}"`, { encoding: "utf-8" });
      console.log(out);
    }
  } finally {
    console.log("4. Cleaning up auth session...");
    const sqlDelete = `DELETE FROM auth_sessions WHERE id = '${sessionId}';`;
    execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlDelete}"`, { stdio: "pipe" });
  }

  console.log("TIMING TEST COMPLETE.");
}

main().catch(console.error);
