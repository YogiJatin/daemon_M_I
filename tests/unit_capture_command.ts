/**
 * tests/unit_capture_command.ts - "note down ..." is a capture command, not chat.
 *
 * The classifier answered "note down a meeting with hydraa ..." in chat and the egress
 * guard replaced the claim with "Nothing was saved." Code now creates the proposal.
 */

import assert from "node:assert";
import { parseCaptureCommand } from "../worker/deterministicParser";

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}\n     ${err?.message || err}`);
  }
}

console.log("\n=== capture commands ===\n");

it("note down a meeting keeps the whole task, wrapper removed", () => {
  const title = parseCaptureCommand(
    "note down a meeting with hydraa today at in the evening regarding our saas app and gandmasthi"
  );
  assert.strictEqual(title, "meeting with hydraa today at in the evening regarding our saas app and gandmasthi");
});

it("note this: strips the wrapper", () => {
  assert.strictEqual(parseCaptureCommand("note this: call mom"), "call mom");
});

it("jot down drops trailing punctuation", () => {
  assert.strictEqual(parseCaptureCommand("jot down buy milk!"), "buy milk");
});

it("add a task works", () => {
  assert.strictEqual(parseCaptureCommand("add a task submit report"), "submit report");
});

it("plain chat is not a capture command", () => {
  assert.strictEqual(parseCaptureCommand("what's up"), null);
  assert.strictEqual(parseCaptureCommand("yoo"), null);
  assert.strictEqual(parseCaptureCommand("note"), null);
});

it("reminders keep their own path", () => {
  assert.strictEqual(parseCaptureCommand("remind me to call mom at 6pm"), null);
});

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
