/**
 * tests/unit_why.ts - guard decisions are recorded per turn, and `/why` explains them.
 *
 * The decision record lives in the existing chat_messages table (the user row's outcome
 * column), so `/why` can answer "why did it say that" without a second per-turn table.
 * This runs against the real migrations via the in-memory D1 mock.
 */

import { createMockD1 } from "./mockD1";
import { routeCommand } from "../worker/commands";
import { recordTurnDecision } from "../worker/telegramConversation";

let pass = 0;
let fail = 0;

function assert(condition: boolean, name: string, detail?: unknown): void {
  if (condition) {
    pass += 1;
    console.log(`  PASS: ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

const NOW = "2026-11-09T10:00:00.000Z";

async function insertTurn(
  db: any,
  updateId: number,
  userText: string,
  replyText: string,
  outcome: string | null
): Promise<string> {
  const userId = `msg_user_${updateId}`;
  await db
    .prepare(
      `INSERT INTO chat_messages (id, update_id, chat_id, message_id, role, text, intent, confidence,
        provider, latency_ms, outcome, status, created_at, updated_at)
       VALUES (?, ?, '1', 1, 'user', ?, NULL, NULL, NULL, NULL, ?, 'done', ?, ?)`
    )
    .bind(userId, updateId, userText, outcome, NOW, NOW)
    .run();
  await db
    .prepare(
      `INSERT INTO chat_messages (id, update_id, chat_id, message_id, role, text, intent, confidence,
        provider, latency_ms, outcome, status, created_at, updated_at)
       VALUES (?, ?, '1', 2, 'assistant', ?, 'chat', 0.9, 'deterministic', 3, NULL, 'sent', ?, ?)`
    )
    .bind(`msg_asst_${updateId}`, updateId, replyText, NOW, NOW)
    .run();
  return userId;
}

async function why(db: any, args = ""): Promise<string> {
  const result = await routeCommand(`/why${args ? ` ${args}` : ""}`, { db, updateId: 1 });
  return result?.response ?? "(null)";
}

async function run(): Promise<void> {
  console.log("\n=== /why AND TURN DECISIONS ===\n");

  const db = createMockD1();

  console.log("--- 1. Empty history ---");
  assert((await why(db)) === "No turns recorded yet.", "no turns gives a clear answer", await why(db));

  console.log("--- 2. A normal turn explains itself ---");
  await insertTurn(db, 42, "Yoo", "Afternoon, sir.", null);
  const normal = await why(db);
  assert(normal.includes("Why (turn 42)"), "names the turn", normal);
  assert(normal.includes("You: Yoo"), "shows the input", normal);
  assert(normal.includes("Read as: chat via deterministic"), "shows intent and provider", normal);
  assert(normal.includes("Guard decisions: none recorded"), "says when nothing was overridden", normal);
  assert(normal.includes("Replied: Afternoon, sir."), "shows the reply", normal);

  console.log("--- 3. Guard decisions are recorded on the turn ---");
  const userId = await insertTurn(db, 43, "call me what", "I will call you sir.", null);
  await recordTurnDecision(db, userId, "guard:style_collapsed_sir");
  await recordTurnDecision(db, userId, "guard:blocked_claim:action_claim_without_commit");
  const stored = await db.prepare("SELECT outcome FROM chat_messages WHERE id = ?").bind(userId).first();
  assert(
    typeof stored?.outcome === "string" && stored.outcome.includes("style_collapsed_sir"),
    "the decision lands in chat_messages.outcome",
    stored?.outcome
  );
  const explained = await why(db);
  assert(explained.includes("Why (turn 43)"), "/why reads the newest turn", explained);
  assert(explained.includes("style_collapsed_sir"), "collapse decision is explained", explained);
  assert(explained.includes("action_claim_without_commit"), "blocked claim is explained", explained);

  console.log("--- 4. A specific turn can be asked for ---");
  const older = await why(db, "42");
  assert(older.includes("Why (turn 42)"), "/why <id> reads that turn", older);
  assert((await why(db, "9999")) === "No turn recorded for update 9999.", "unknown turn is reported plainly");

  console.log("--- 5. Recording is append-only and capped ---");
  const capped = await insertTurn(db, 44, "x", "y", null);
  for (let i = 0; i < 40; i += 1) {
    await recordTurnDecision(db, capped, `guard:code_${i}`);
  }
  const cappedRow = await db.prepare("SELECT outcome FROM chat_messages WHERE id = ?").bind(capped).first();
  assert(typeof cappedRow?.outcome === "string" && cappedRow.outcome.length <= 300, "outcome stays bounded", cappedRow?.outcome?.length);

  console.log(`\nTOTAL: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((error) => {
  console.log(`  FAIL: crashed -> ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
