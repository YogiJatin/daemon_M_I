/**
 * tests/unit_reply_style.ts - persona style gate and IST greeting boundaries.
 *
 * Covers the two mechanical persona rules plus the greeting clock, which must read IST
 * regardless of where the Worker runs:
 *   - "sir, sir" collapses, including "I will call you sir, sir."
 *   - imperatives aimed at the owner (Specify / Provide / State) are rejected
 *   - greetings at 05:00, 11:00, 15:00, 19:00 and 23:30 IST
 */

import { applyReplyStyle, checkReplyStyle, collapseDuplicateSir } from "../worker/replyStyle";
import { matchDeterministicReply } from "../worker/greetingMatcher";
import { countAddressTerms } from "../worker/personaStyle";

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

function istAt(hour: number, minute: number): Date {
  // IST is UTC+05:30 with no DST.
  return new Date(Date.UTC(2026, 10, 9, hour, minute, 0) - 5.5 * 60 * 60 * 1000);
}

function runReplyStyleTests(): void {
  console.log("\n=== REPLY STYLE GATE ===\n");

  console.log("--- 1. Duplicate sir is collapsed ---");
  assert(collapseDuplicateSir("I will call you sir, sir.") === "I will call you sir.", "trailing 'sir, sir' collapses");
  assert(collapseDuplicateSir("Sir, sir, ready.") === "Sir, ready.", "leading duplicate collapses and keeps case");
  assert(collapseDuplicateSir("sir sir sir") === "sir", "a run of three collapses to one");
  assert(collapseDuplicateSir("Noted, sir.") === "Noted, sir.", "a single sir is untouched");

  // FIX 7: applyReplyStyle is a passthrough; the model owns the reply.
  // collapseDuplicateSir remains available as a utility.
  const callReply = applyReplyStyle("I will call you sir, sir.");
  assert(callReply.text === "I will call you sir, sir.", "applyReplyStyle is a passthrough", callReply.text);
  assert(callReply.violations.length === 0, "no violations", callReply.violations);
  assert(callReply.decisions.length === 0, "no decisions recorded", callReply.decisions);
  assert(callReply.retryable === false, "not retryable", callReply.retryable);

  console.log("--- 2. Imperatives aimed at the owner are rejected ---");
  for (const banned of [
    "Specify the request, sir.",
    "Provide the date, sir.",
    "State your task, sir.",
    "Noted. Specify what you need, sir.",
  ]) {
    // FIX 7: applyReplyStyle is a passthrough; imperatives are not blocked by code.
    const result = applyReplyStyle(banned);
    assert(result.text === banned, "passthrough keeps the reply", result.text);
    assert(result.retryable === false, "not retryable", result.retryable);
  }

  // Descriptive uses of the same words must not be blocked.
  for (const allowed of [
    "The provider stated a limit of 3 per day, sir.",
    "I could not find a specification for that, sir.",
    "Noted, sir.",
  ]) {
    const result = applyReplyStyle(allowed);
    assert(result.violations.length === 0, `allows: ${allowed}`, result.violations);
  }

  assert(checkReplyStyle("Specify the request, sir.")[0].code === "owner_directed_imperative", "checkReplyStyle reports the code");

  console.log("--- 3. Bare questions are conversation, not canned fragments ---");
  // Persona v3 sends anything longer than a bare greeting/thanks/ack to the LLM in CHAT
  // mode, so a one-word question must NOT get a canned line any more.
  assert(matchDeterministicReply("What", istAt(15, 0)) === null, "a bare interrogative goes to the LLM");
  assert(matchDeterministicReply("how are you", istAt(15, 0)) === null, "'how are you' goes to the LLM");
  assert(matchDeterministicReply("what do you think about this?", istAt(15, 0)) === null, "a question mark opts out");

  console.log("--- 4. FIX 7: greetings go to the model, not canned lines ---");
  assert(matchDeterministicReply("Yoo", istAt(5, 0)) === null, "greetings are not canned");
  assert(matchDeterministicReply("hello", istAt(15, 0)) === null, "greetings are not canned");

  console.log(`\nTOTAL: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
  if (fail > 0) process.exit(1);
}

runReplyStyleTests();
