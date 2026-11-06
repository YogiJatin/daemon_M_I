/**
 * tests/run_gate3_conversations.ts - Gate G3: 10 Deployed-Bot Conversations
 *
 * Sends 10 diverse conversations to the deployed Cloudflare Worker webhook
 * and queries the remote D1 `chat_messages` table to verify real provider
 * execution, latency, status, and intent classification.
 */

import crypto from "node:crypto";
import { execSync } from "node:child_process";

const BASE_URL = "https://personal-ai-os.jatin-personal-ai.workers.dev";
const OWNER_ID = 8364430714;

interface ConversationSpec {
  name: string;
  text: string;
}

const CONVERSATIONS: ConversationSpec[] = [
  { name: "1. Ambiguous time", text: "buy milk at 3" },
  { name: "2. Due date vs reminder", text: "submit physics assignment by tonight" },
  { name: "3. Implicit obligation", text: "I need to submit the project report tomorrow" },
  { name: "4. Bodily state (disqualified)", text: "I need to sleep early tonight" },
  { name: "5. Schedule query", text: "what do I have today" },
  { name: "6. Chat intent (no schedule claims)", text: "how are you doing today" },
  { name: "7. Daily schedule change", text: "leaving college early at 3pm today" },
  { name: "8. Remember note", text: "remember my locker passcode is 8841" },
  { name: "9. Hinglish commitment", text: "Kal subah assignment submit karna hai" },
  { name: "10. Telugu commitment", text: "Nenu ee pani repu cheyyali" },
];

async function main() {
  console.log("==================================================================");
  console.log("RUNNING GATE G3: 10 DEPLOYED-BOT CONVERSATIONS");
  console.log("==================================================================\n");

  const rawToken = "g3_test_token_" + crypto.randomBytes(16).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const sessionId = "g3-sess-" + crypto.randomBytes(8).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  console.log("1. Setting up temporary owner auth session on remote D1...");
  const sqlInsert = `INSERT INTO auth_sessions (id, token_hash, owner_user_id, workspace_id, expires_at, created_at, last_seen_at) VALUES ('${sessionId}', '${tokenHash}', '${OWNER_ID}', 'default', '${expiresAt}', '${nowIso}', '${nowIso}');`;
  execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlInsert}"`, { stdio: "pipe" });

  const updateIds: number[] = [];

  try {
    console.log("2. Sending 10 conversations to deployed Worker webhook...\n");

    for (let i = 0; i < CONVERSATIONS.length; i++) {
      const conv = CONVERSATIONS[i];
      const updateId = Math.floor(Date.now() / 1000) + i * 100 + Math.floor(Math.random() * 50);
      updateIds.push(updateId);

      console.log(`[${i + 1}/10] Sending "${conv.text}" (update_id: ${updateId})...`);

      const res = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${rawToken}`,
        },
        body: JSON.stringify({
          update_id: updateId,
          message: {
            message_id: updateId,
            from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
            chat: { id: OWNER_ID, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text: conv.text,
          },
        }),
      });

      console.log(`       -> HTTP ${res.status}`);
      // brief pause between messages
      await new Promise((r) => setTimeout(r, 1200));
    }

    console.log("\n3. Waiting 12 seconds for async ctx.waitUntil processing on remote Worker...");
    await new Promise((r) => setTimeout(r, 12000));

    console.log("\n4. Querying remote D1 `chat_messages` table for results...\n");
    const updateIdList = updateIds.join(",");
    const sqlQuery = `SELECT update_id, role, text, intent, confidence, provider, latency_ms, outcome, status FROM chat_messages WHERE update_id IN (${updateIdList}) ORDER BY update_id ASC, id ASC;`;

    const result = execSync(
      `npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlQuery}"`,
      { encoding: "utf-8" }
    );

    console.log("RAW REMOTE D1 CHAT_MESSAGES OUTPUT:");
    console.log(result);

  } finally {
    console.log("\n5. Cleaning up temporary auth session from remote D1...");
    const sqlDelete = `DELETE FROM auth_sessions WHERE id = '${sessionId}';`;
    execSync(`npx wrangler d1 execute personal-ai-os-db --remote --command="${sqlDelete}"`, { stdio: "pipe" });
  }

  console.log("\nGATE G3 CONVERSATIONS COMPLETED.");
}

main().catch((err) => {
  console.error("FATAL in G3 runner:", err);
  process.exit(1);
});
