/**
 * tests/unit_identity.ts - "who am i" answers with a short profile, and Daemon never
 * credits another company as its creator.
 */

import assert from "node:assert";
import { formatIdentityAnswer } from "../worker/identity";
import { DAEMON_PERSONA } from "../worker/prompts";

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

console.log("\n=== identity ===\n");

it("who am i returns the name, not the memory table", () => {
  const answer = formatIdentityAnswer([
    "User prefers to be addressed as sir, boss, master, or similar pronouns.",
    "Assistant name is Daemon. Owner is Doodam Yogi Jatin Sai, also called Yogi or Jatin, nickname Yuki.",
  ]);
  assert.match(answer, /You are Doodam Yogi Jatin Sai/);
  assert.doesNotMatch(answer, /mem_/);
  assert.doesNotMatch(answer, /telegram_ai_suggested/);
  assert.doesNotMatch(answer, /trust/);
});

it("known work and interests are listed briefly", () => {
  const answer = formatIdentityAnswer([
    "Owner is Doodam Yogi Jatin Sai, nickname Yuki.",
    "He is a third-year ECE student.",
    "He loves building SaaS apps.",
    "He dislikes loud meetings.",
  ]);
  assert.match(answer, /You are Doodam Yogi Jatin Sai/);
  assert.match(answer, /third-year ECE student/);
  assert.match(answer, /SaaS/);
  assert.ok(answer.split("\n").length <= 6, answer);
});

it("it asks when the profile is thin", () => {
  const answer = formatIdentityAnswer(["Owner is Doodam Yogi Jatin Sai."]);
  assert.match(answer, /Tell me what you do/);
});

it("an empty memory still answers and asks", () => {
  const answer = formatIdentityAnswer([]);
  assert.match(answer, /Tell me what you do/);
});

it("the persona forbids crediting another company", () => {
  assert.match(DAEMON_PERSONA, /Never say you were created, trained or owned by OpenAI/);
  assert.match(DAEMON_PERSONA, /your owner built you/);
});

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
