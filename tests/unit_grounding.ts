/**
 * tests/unit_grounding.ts - narrow grounding: ids, dates, times and numbers must be traceable.
 *
 * Also pins the SYSTEM RESULTS block that every model request now carries.
 * The cases that must NOT be blocked (weekdays, month names, product names, the assistant's
 * own name) are here because over-blocking is the failure mode that would make this useless.
 */

import { SYSTEM_RESULTS_HEADER, withSystemResults } from "../worker/prompts";
import {
  UNGROUNDED_REPLY,
  extractCheckableFacts,
  verifyReplyGrounding,
} from "../worker/groundingVerifier";
import { checkReplyStyle } from "../worker/replyStyle";

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

const CONTEXT = `<DATA type="context">
Current time (IST): Sunday, 9 November 2026 at 15:00
Owner: Jatin
Home city: Hyderabad
Morning anchor: 08:00
</DATA>

<DATA type="recent_tasks">
id: task_ABC123456789 | title: Submit DBMS assignment | deadline: 2026-11-10 17:00
id: task_DEF987654321 | title: Pay electricity bill | deadline: 2026-11-15 09:30
</DATA>

SYSTEM RESULTS (computed by code; treat as authoritative)
- 2 tasks are due this week
- next class at 16:45 in Room 204
</DATA>`;

console.log("\n=== SYSTEM RESULTS BLOCK ===\n");

{
  const prompt = withSystemResults("owner message");
  assert(prompt.includes(SYSTEM_RESULTS_HEADER), "the block is labelled");
  assert(prompt.includes("(none)"), "an empty block states (none) rather than being omitted");
  assert(prompt.startsWith("owner message"), "the original prompt is preserved");

  const withValues = withSystemResults("owner message", ["3 tasks due", "next class 09:00"]);
  assert(withValues.includes("- 3 tasks due"), "computed results are listed");
  assert(!withValues.includes("(none)"), "no placeholder when results exist");

  const twice = withSystemResults(withValues, ["something else"]);
  assert(twice === withValues, "the block is idempotent");

  const many = withSystemResults("p", new Array(20).fill("row"));
  assert(many.split("\n").filter((line) => line.startsWith("- row")).length === 10, "results are capped at 10");
}

console.log("\n=== FACT EXTRACTION ===\n");

{
  const facts = extractCheckableFacts("You have 2 tasks: task_ABC123456789 due 2026-11-10 at 17:00, sir.");
  assert(facts.includes("task_ABC123456789"), "ids are extracted", facts);
  assert(facts.includes("2026-11-10"), "ISO dates are extracted", facts);
  assert(facts.includes("17:00"), "clock times are extracted", facts);
  assert(facts.includes("2"), "plain numbers are extracted", facts);
  assert(!facts.includes("17") && !facts.includes("00"), "time digits are not re-read as numbers", facts);

  const noFacts = extractCheckableFacts("Understood, sir.");
  assert(noFacts.length === 0, "a reply without facts has nothing to check", noFacts);
}

console.log("\n=== GROUNDED REPLIES PASS ===\n");

{
  const groundedReplies = [
    "You have 2 tasks due this week, sir.",
    "Your next class is at 16:45 in Room 204.",
    "Submit DBMS assignment is due 2026-11-10 at 17:00, sir.",
    "task_ABC123456789 is still open.",
    "Your class is at 16:45 on Monday, sir.",
    "Your morning anchor is 8:00, sir.",
    "The DBMS assignment is due on Tuesday, 10 November.",
    "Noted, sir.",
  ];
  for (const reply of groundedReplies) {
    const verdict = verifyReplyGrounding(reply, [CONTEXT]);
    assert(verdict.grounded, `passes: ${reply}`, verdict.ungrounded);
  }
}

console.log("\n=== INVENTED SPECIFICS ARE BLOCKED ===\n");

{
  const invented = [
    "You have 7 tasks due this week, sir.",
    "Your next class is at 08:15 in Room 204.",
    "The assignment is due 2026-12-25.",
    "task_ZZZ999999999 is still open.",
  ];
  for (const reply of invented) {
    const verdict = verifyReplyGrounding(reply, [CONTEXT]);
    assert(!verdict.grounded, `blocked: ${reply}`, verdict.ungrounded);
  }
}

console.log("\n=== LANGUAGE IS NOT FACT-CHECKED ===\n");

{
  const languageReplies = [
    "I am Daemon, your personal AI OS.",
    "Groq is the provider answering this, sir.",
    "Your week looks heavy on Wednesday and Thursday.",
    "That is a decision for December, sir.",
    "Understood, sir.",
  ];
  for (const reply of languageReplies) {
    const verdict = verifyReplyGrounding(reply, [CONTEXT]);
    assert(verdict.grounded, `not flagged: ${reply}`, verdict.ungrounded);
  }
}

console.log("\n=== FALLBACK TEXT ===\n");

{
  assert(UNGROUNDED_REPLY === "I don't have anything on that, sir.", "fallback is the agreed sentence", UNGROUNDED_REPLY);
  assert(checkReplyStyle(UNGROUNDED_REPLY).length === 0, "fallback passes the style linter");

  const noSources = verifyReplyGrounding("You have 2 tasks, sir.", []);
  assert(!noSources.grounded, "with no sources nothing can be grounded", noSources);
}

console.log(`\nTOTAL: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
if (fail > 0) process.exit(1);
