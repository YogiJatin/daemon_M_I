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

  const callReply = applyReplyStyle("I will call you sir, sir.");
  assert(callReply.text === "I will call you sir.", "applyReplyStyle returns the collapsed text", callReply.text);
  assert(callReply.violations.length === 0, "collapsed text has no violations", callReply.violations);
  assert(callReply.decisions.includes("style_collapsed_sir"), "the collapse is recorded as a decision", callReply.decisions);
  assert(!/\bsir\b[\s,;]*\bsir\b/i.test(callReply.text), "no 'sir, sir' can survive");

  console.log("--- 2. Imperatives aimed at the owner are rejected ---");
  for (const banned of [
    "Specify the request, sir.",
    "Provide the date, sir.",
    "State your task, sir.",
    "Noted. Specify what you need, sir.",
  ]) {
    const result = applyReplyStyle(banned);
    const codes = result.violations.map((violation) => violation.code);
    assert(codes.includes("owner_directed_imperative"), `rejects: ${banned}`, codes);
    assert(result.text === "Understood, sir.", "blocked replies fall back instead of sending", result.text);
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

  console.log("--- 4. Greetings use IST, not the runtime timezone ---");
  const cases: Array<{ hour: number; minute: number; expected: RegExp; label: string }> = [
    { hour: 5, minute: 0, expected: /morning/i, label: "05:00 IST" },
    { hour: 11, minute: 0, expected: /morning/i, label: "11:00 IST" },
    { hour: 15, minute: 0, expected: /afternoon/i, label: "15:00 IST" },
    { hour: 19, minute: 0, expected: /evening/i, label: "19:00 IST" },
    { hour: 23, minute: 30, expected: /night/i, label: "23:30 IST" },
  ];

  for (const testCase of cases) {
    const reply = matchDeterministicReply("Yoo", istAt(testCase.hour, testCase.minute));
    assert(Boolean(reply && testCase.expected.test(reply.reply)), `${testCase.label} -> ${testCase.expected}`, reply?.reply);
    assert(countAddressTerms(reply?.reply || "", ["sir", "boss", "master"]) <= 1, "at most one address term", reply?.reply);
  }

  // Boundary checks: 05:00 starts morning, 12:00 flips to afternoon, 17:00 to evening,
  // 22:00 to night.
  assert(/morning/i.test(matchDeterministicReply("hello", istAt(4, 59))?.reply || "") === false, "04:59 is night, not morning");
  assert(/morning/i.test(matchDeterministicReply("hello", istAt(11, 59))?.reply || ""), "11:59 IST is still morning");
  assert(/afternoon/i.test(matchDeterministicReply("hello", istAt(12, 0))?.reply || ""), "12:00 IST is afternoon");
  assert(/afternoon/i.test(matchDeterministicReply("hello", istAt(16, 59))?.reply || ""), "16:59 IST is still afternoon");
  assert(/evening/i.test(matchDeterministicReply("hello", istAt(17, 0))?.reply || ""), "17:00 IST is evening");

  console.log(`\nTOTAL: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
  if (fail > 0) process.exit(1);
}

runReplyStyleTests();
