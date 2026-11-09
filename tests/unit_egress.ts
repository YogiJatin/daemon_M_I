/**
 * tests/unit_egress.ts — Action-claim egress guard (Stage 1)
 *
 * Verifies:
 * 1. Guard is opt-in: no context => text untouched (reminders/digests).
 * 2. First-person and leading completed-action claims are blocked.
 * 3. A committed code result is allowed verbatim.
 * 4. A claim with a committed result in the same turn is replaced by that result.
 * 5. A claim with no committed result becomes "No action taken."
 * 6. Leaked JSON/provider payloads are still dropped by sanitizeOutboundMessage.
 * 7. Clean factual replies pass through.
 */

import assert from "node:assert";
import {
  guardReply,
  containsActionClaim,
  NO_ACTION_TEXT,
  normalizeForClaimCheck,
} from "../worker/egressGuard";
import { sanitizeOutboundMessage } from "../worker/telegram";

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}\n     ${err.message}`);
  }
}

console.log("\n=== Action-claim egress guard ===");

it("leaves reminders untouched when no chat context is supplied", () => {
  const text = "I've deleted the old reminder.";
  assert.strictEqual(guardReply(text).text, text);
  assert.strictEqual(guardReply(text).blocked, false);
});

it("detects first-person completed-action claims", () => {
  assert.strictEqual(containsActionClaim("I've removed 3 memories."), true);
  assert.strictEqual(containsActionClaim("I have scheduled your reminder."), true);
  assert.strictEqual(containsActionClaim("Got it, removed the lab note."), true);
  assert.strictEqual(containsActionClaim("Deleted 1 memory."), true);
  assert.strictEqual(containsActionClaim("Completed all tasks."), true);
});

it("does not treat factual mid-sentence uses as claims", () => {
  assert.strictEqual(containsActionClaim("The report completed early."), false);
  assert.strictEqual(containsActionClaim("No record of that, sir."), false);
  assert.strictEqual(containsActionClaim("Your next class is at 10:00."), false);
});

it("detects claims written with curly or full-width punctuation", () => {
  // Typographic apostrophe (U+2019) instead of ASCII.
  assert.strictEqual(containsActionClaim("I\u2019ve removed 3 memories."), true);
  // Full-width letters and apostrophe.
  assert.strictEqual(containsActionClaim("\uFF29\uFF07\uFF56\uFF45 deleted it."), true);
  // Em dash after a leading verb.
  assert.strictEqual(containsActionClaim("Done\u2014removed the note."), true);
  // Non-breaking space between words.
  assert.strictEqual(containsActionClaim("I've\u00A0scheduled your reminder."), true);
});

it("detects the phrasings that used to slip through", () => {
  assert.strictEqual(containsActionClaim("I've gone ahead and deleted it."), true);
  assert.strictEqual(containsActionClaim("Consider it done."), true);
  assert.strictEqual(containsActionClaim("Your task has been added."), true);
  assert.strictEqual(containsActionClaim("Marked it as done."), true);
  assert.strictEqual(containsActionClaim("I have already cancelled it."), true);
});

it("normalises punctuation and whitespace for claim detection", () => {
  assert.strictEqual(normalizeForClaimCheck("  I\u2019ve   REMOVED it. "), "i've removed it.");
  assert.strictEqual(normalizeForClaimCheck("Done\u2014removed"), "done-removed");
});

it("allows the exact committed code result", () => {
  const verdict = guardReply("Deleted 1 memory.", { actionResults: ["Deleted 1 memory."] });
  assert.strictEqual(verdict.blocked, false);
  assert.strictEqual(verdict.text, "Deleted 1 memory.");
});

it("replaces an unbacked claim with No action taken.", () => {
  const verdict = guardReply("I've removed the memory about ECE.", { actionResults: [] });
  assert.strictEqual(verdict.blocked, true);
  assert.strictEqual(verdict.text, NO_ACTION_TEXT);
});

it("replaces an unbacked claim with the committed result when one exists", () => {
  const verdict = guardReply("I've scheduled your reminder for 5pm.", {
    actionResults: ["Deleted 2 memories."],
  });
  assert.strictEqual(verdict.blocked, true);
  assert.strictEqual(verdict.text, "Deleted 2 memories.");
});

it("passes clean chat replies through", () => {
  const verdict = guardReply("No data.", { actionResults: [] });
  assert.strictEqual(verdict.blocked, false);
  assert.strictEqual(verdict.text, "No data.");
});

it("keeps the existing leaked-payload guard and honors the egress option", () => {
  const leaked = JSON.stringify({ intent: "chat", reply_text: "hey", _mock: true });
  assert.match(sanitizeOutboundMessage(leaked), /temporarily offline/i);
  assert.strictEqual(
    sanitizeOutboundMessage("I've removed it.", { actionResults: [] }),
    NO_ACTION_TEXT
  );
  assert.strictEqual(sanitizeOutboundMessage("I've removed it."), "I've removed it.");
});

console.log(`\nTOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}\n`);
if (failed > 0) process.exitCode = 1;
