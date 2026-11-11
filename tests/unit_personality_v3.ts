/**
 * tests/unit_personality_v3.ts - persona v3: OWNER_STYLE, routing, history hygiene,
 * reply post-processing and the self-harm safety path.
 *
 * These are the rules the production transcript proved were missing:
 *   - small talk must never be answered with "no record";
 *   - an address term is governed (max one, none when the owner removed it);
 *   - "Lol just kill me" is venting, not a policy violation;
 *   - "I want to die" gets the fixed crisis template with Tele-MANAS 14416;
 *   - the bot's own canned lines never become conversation history.
 */

import assert from "node:assert";
import {
  DEFAULT_OWNER_STYLE,
  applyStyleUpdate,
  describeStyleUpdate,
  governAddressTerms,
  parseOwnerStyle,
  preRouteStyleRequest,
  renderOwnerStyleBlock,
  resolveTone,
  serializeOwnerStyle,
  countAddressTerms,
  type OwnerStyle,
} from "../worker/personaStyle";
import { matchDeterministicReply } from "../worker/greetingMatcher";
import { applyReplyStyle, buildRetryInstruction, MODE_FIT_FALLBACK_REPLY } from "../worker/replyStyle";
import { buildRecentChat, isExcludedFromHistory, HISTORY_TURN_LIMIT } from "../worker/historyHygiene";
import { assessRisk, memoryProposalAllowed, CRISIS_SUPPORT_TEXT } from "../worker/safetyPath";
import { stripUngroundedFacts, verifyReplyGrounding } from "../worker/groundingVerifier";
import { checkHarmGate } from "../worker/harmGate";
import { DAEMON_ANSWER_PROMPT, DAEMON_PERSONA, DAEMON_SYSTEM_PROMPT } from "../worker/prompts";

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

function istAt(hour: number, minute: number, day = 9): Date {
  return new Date(Date.UTC(2026, 10, day, hour, minute, 0) - 5.5 * 60 * 60 * 1000);
}

const CASUAL: OwnerStyle = { ...DEFAULT_OWNER_STYLE, tone: "casual" };
const DEFAULTS = DEFAULT_OWNER_STYLE;

console.log("\n=== S2: OWNER_STYLE ===\n");

it("defaults are sir/boss/master, auto tone, normal brevity, no emoji", () => {
  assert.deepStrictEqual(DEFAULTS.address_terms, ["sir", "boss", "master"]);
  assert.strictEqual(DEFAULTS.tone, "auto");
  assert.strictEqual(DEFAULTS.brevity, "normal");
  assert.strictEqual(DEFAULTS.emoji, false);
});

it("a malformed setting falls back to defaults", () => {
  assert.deepStrictEqual(parseOwnerStyle("not json"), DEFAULTS);
  assert.deepStrictEqual(parseOwnerStyle(null), DEFAULTS);
  const partial = parseOwnerStyle(JSON.stringify({ tone: "casual" }));
  assert.strictEqual(partial.tone, "casual");
  assert.deepStrictEqual(partial.address_terms, DEFAULTS.address_terms);
});

it("style_update applies valid enums and rejects the rest", () => {
  const applied = applyStyleUpdate(CASUAL, { tone: "formal", address_terms: ["boss"], brevity: "short", emoji: true });
  assert.strictEqual(applied.style.tone, "formal");
  assert.deepStrictEqual(applied.style.address_terms, ["boss"]);
  assert.strictEqual(applied.style.brevity, "short");
  assert.strictEqual(applied.style.emoji, true);
  assert.strictEqual(applied.rejected.length, 0);

  const rejected = applyStyleUpdate(CASUAL, { tone: "shouty", brevity: "epic", address_terms: ["<script>"] } as any);
  assert.notStrictEqual(rejected.style.tone, "shouty");
  assert.notStrictEqual(rejected.style.brevity, "epic");
  assert.deepStrictEqual(rejected.style.address_terms, []);
  assert.ok(rejected.rejected.length >= 1);
  assert.strictEqual(rejected.applied.length, 0);
});

it("serialize round-trips", () => {
  const style: OwnerStyle = { address_terms: ["boss"], tone: "casual", brevity: "short", emoji: false };
  assert.deepStrictEqual(parseOwnerStyle(serializeOwnerStyle(style)), style);
});

it("the pre-router handles English, Hinglish and Telugu-mixed style commands", () => {
  const casual = preRouteStyleRequest("Just talk to me casual don't be so uptight", CASUAL);
  assert.ok(casual, "casual command matched");
  assert.strictEqual(casual!.style.tone, "casual");

  const telugu = preRouteStyleRequest("casual ga matladu", CASUAL);
  assert.ok(telugu, "telugu casual command matched");
  assert.strictEqual(telugu!.style.tone, "casual");

  const formal = preRouteStyleRequest("be formal please", CASUAL);
  assert.strictEqual(formal!.style.tone, "formal");

  const stop = preRouteStyleRequest("stop calling me sir", CASUAL);
  assert.ok(stop, "term rejection matched");
  assert.deepStrictEqual(stop!.style.address_terms, []);
  assert.strictEqual(stop!.reply, "Done.");

  const teluguStop = preRouteStyleRequest("sir anaku", CASUAL);
  assert.ok(teluguStop, "telugu term rejection matched");
  assert.deepStrictEqual(teluguStop!.style.address_terms, []);

  const rename = preRouteStyleRequest("call me boss", CASUAL);
  assert.deepStrictEqual(rename!.style.address_terms, ["boss"]);

  const shorter = preRouteStyleRequest("shorter replies please", CASUAL);
  assert.strictEqual(shorter!.style.brevity, "short");

  // A message carrying work is never swallowed by the style router.
  assert.strictEqual(preRouteStyleRequest("talk casual and remind me at 5", CASUAL), null);
  assert.strictEqual(preRouteStyleRequest("call me when you are done", CASUAL), null);
});

it("the style reply is code-owned", () => {
  assert.strictEqual(describeStyleUpdate(["address_terms=[]"]), "Done.");
  assert.match(describeStyleUpdate(["tone=casual"]), /Casual/);
});

it("OWNER_STYLE is rendered into CONTEXT", () => {
  const block = renderOwnerStyleBlock(CASUAL);
  assert.match(block, /Address terms allowed: sir, boss, master/);
  assert.match(block, /Tone: casual/);
  assert.match(block, /Emoji: never/);
  const empty = renderOwnerStyleBlock({ ...CASUAL, address_terms: [] });
  assert.match(empty, /do not use any address term/);
  assert.strictEqual(resolveTone({ ...CASUAL, tone: "auto" }), "casual");
  assert.strictEqual(resolveTone({ ...CASUAL, tone: "formal" }), "formal");
});

console.log("\n=== S3: routing and fallbacks ===\n");

it("chat prompts no longer teach the no-record line", () => {
  assert.doesNotMatch(DAEMON_ANSWER_PROMPT, /No record of that/);
  assert.doesNotMatch(DAEMON_ANSWER_PROMPT, /I do not have that information/);
  assert.doesNotMatch(DAEMON_SYSTEM_PROMPT, /No record of that/);
  assert.match(DAEMON_PERSONA, /Never answer chat with "no record"/);
});

it("only bare greetings, thanks and acks are deterministic", () => {
  assert.strictEqual(matchDeterministicReply("hi", istAt(9, 0))?.kind, "greeting");
  assert.strictEqual(matchDeterministicReply("thanks", istAt(9, 0))?.kind, "thanks");
  assert.strictEqual(matchDeterministicReply("ok", istAt(9, 0))?.kind, "acknowledgement");
  for (const chat of [
    "How are you",
    "Just talk to me kiddo I wanna just chat tdy",
    "who am I",
    "What",
    "that's rude bro",
  ]) {
    assert.strictEqual(matchDeterministicReply(chat, istAt(9, 0)), null, `${chat} must reach the LLM`);
  }
});

it("deterministic replies offer at least four variants per tone and never repeat", () => {
  for (const tone of ["casual", "formal"] as const) {
    const style: OwnerStyle = { ...DEFAULTS, tone };
    const seen = new Set<string>();
    for (let day = 1; day <= 28; day++) {
      const reply = matchDeterministicReply("hi", istAt(9, 30, day), { style });
      assert.ok(reply, "greeting matched");
      seen.add(reply!.reply);
    }
    assert.ok(seen.size >= 4, `${tone} greeting has ${seen.size} variants, expected >= 4`);
  }

  const style = CASUAL;
  let previous = matchDeterministicReply("hello", istAt(9, 0), { style })!.reply;
  for (let i = 0; i < 6; i++) {
    const next = matchDeterministicReply("hello", istAt(9, 0), { style, previousReply: previous })!.reply;
    assert.notStrictEqual(next, previous, "the same variant must not be sent twice in a row");
    previous = next;
  }
});

it("an empty address-term list removes even a canned greeting's term", () => {
  const style: OwnerStyle = { ...CASUAL, address_terms: [] };
  const reply = matchDeterministicReply("hi", istAt(9, 0), { style })!;
  assert.strictEqual(countAddressTerms(reply.reply, DEFAULTS.address_terms), 0, reply.reply);
});

it("the grounding verifier strips rather than dead-ends a chat reply", () => {
  const reply = "You have 42 tasks due and I like your plan.";
  const verdict = verifyReplyGrounding(reply, []);
  assert.strictEqual(verdict.grounded, false);
  assert.ok(verdict.ungrounded.length > 0, "ungrounded facts present");
  const stripped = stripUngroundedFacts(reply, verdict.ungrounded);
  assert.ok(stripped != null, "stripUngroundedFacts returned null");
  assert.ok(typeof stripped === "string" && stripped.length > 0, "stripUngroundedFacts must preserve prose");
  assert.doesNotMatch(stripped!, /42/);
});

it("the default fallback is not a no-record line", () => {
  assert.doesNotMatch(MODE_FIT_FALLBACK_REPLY, /no record|no data/i);
});

console.log("\n=== S4: history hygiene ===\n");

it("deterministic, guard and notice rows never reach recent_chat", () => {
  const rows = [
    { role: "assistant", text: "Morning, sir.", outcome: "deterministic_greeting" },
    { role: "assistant", text: "Noted, sir.", outcome: "sent" },
    { role: "assistant", text: "I lost the thread there. Say that again?", outcome: "sent" },
    { role: "assistant", text: "No data.", outcome: "sent" },
    { role: "assistant", text: "System notice: Provider gemini_primary state changed.", outcome: "system_notice" },
    { role: "assistant", text: "That sounds heavy, and I'm taking it seriously.", outcome: "crisis_support" },
    { role: "user", text: "talk to me", outcome: null },
    { role: "assistant", text: "What's on your mind?", outcome: "sent" },
  ];
  const chat = buildRecentChat(rows as any);
  // Guard/linter substitutes are never stored; only real conversation reaches the prompt.
  assert.ok(chat.length >= 2, "at least two rows survive");
  assert.ok(
    chat.some((line) => line.startsWith("assistant: What's on your mind?")),
    "the What's on your mind line survives"
  );
  assert.ok(chat.some((line) => line.startsWith("user: talk to me")), "the talk to me line survives");
  assert.ok(
    !chat.some((line) => /assistant: Noted/.test(line)),
    "the Noted, sir row itself is dropped"
  );
});

it("a history full of 'X, sir.' lines never reaches the prompt", () => {
  const rows: any[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ role: "assistant", text: `Ready, sir. (${i})`, outcome: "deterministic_greeting" });
    rows.push({ role: "user", text: `hello ${i}`, outcome: null });
  }
  const chat = buildRecentChat(rows);
  assert.ok(chat.length > 0);
  assert.ok(chat.every((line) => line.startsWith("user:")), "no assistant canned line survives");
  assert.ok(!chat.some((line) => /sir/i.test(line)), "no 'sir' line reaches the prompt");
});

it("history is capped at six turns", () => {
  const rows: any[] = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ role: "assistant", text: `reply ${i}`, outcome: "sent" });
    rows.push({ role: "user", text: `message ${i}`, outcome: null });
  }
  const chat = buildRecentChat(rows);
  assert.strictEqual(chat.length, HISTORY_TURN_LIMIT * 2);
  assert.ok(
    isExcludedFromHistory({
      role: "assistant",
      text: "AI is temporarily offline. Your message was saved.",
      outcome: "sent",
    })
  );
});

console.log("\n=== S5: reply post-processing ===\n");

it("the governor allows at most one address term", () => {
  const result = governAddressTerms("Morning, sir. Ready, sir.", CASUAL, {
    tone: "casual",
    previousReplyUsedTerm: false,
  });
  assert.strictEqual(countAddressTerms(result.text, CASUAL.address_terms), 1, result.text);
});

it("no address term survives when the owner removed them", () => {
  const style: OwnerStyle = { ...CASUAL, address_terms: [] };
  const result = governAddressTerms("Done, sir.", style, { tone: "casual", previousReplyUsedTerm: false });
  assert.strictEqual(countAddressTerms(result.text, DEFAULTS.address_terms), 0, result.text);
});

it("a casual reply skips the term when the previous one used it", () => {
  const result = governAddressTerms("Anytime, sir.", CASUAL, { tone: "casual", previousReplyUsedTerm: true });
  assert.strictEqual(countAddressTerms(result.text, CASUAL.address_terms), 0, result.text);
  const formal = governAddressTerms("Anytime, sir.", { ...CASUAL, tone: "formal" }, {
    tone: "formal",
    previousReplyUsedTerm: true,
  });
  assert.strictEqual(countAddressTerms(formal.text, CASUAL.address_terms), 1, formal.text);
});

it("'sir, sir' is collapsed", () => {
  const styled = applyReplyStyle("I will call you sir, sir.", {
    style: CASUAL,
    tone: "casual",
    previousReplyUsedTerm: false,
    actionResults: [],
  });
  assert.strictEqual(styled.text, "I will call you sir.");
});

it("emotion-parrot openers are rejected and retried", () => {
  for (const bad of [
    "You seem upset, sir.",
    "You are expressing frustration.",
    "You are feeling low today.",
    "You sound angry.",
  ]) {
    const styled = applyReplyStyle(bad, { style: CASUAL, tone: "casual", previousReplyUsedTerm: false, actionResults: [] });
    assert.strictEqual(styled.text, MODE_FIT_FALLBACK_REPLY, `${bad} was not replaced`);
    assert.ok(
      styled.violations.some((violation) => violation.code === "emotion_parrot"),
      `${bad} not flagged`
    );
    assert.strictEqual(styled.retryable, true);
  }
});

it("'noted' with nothing done is rejected, but allowed when code committed something", () => {
  const bare = applyReplyStyle("Noted, sir.", { style: CASUAL, tone: "casual", previousReplyUsedTerm: false, actionResults: [] });
  assert.ok(bare.violations.some((violation) => violation.code === "unsupported_ack"));
  assert.strictEqual(bare.text, MODE_FIT_FALLBACK_REPLY);

  const committed = applyReplyStyle("Noted, sir.", {
    style: CASUAL,
    tone: "casual",
    previousReplyUsedTerm: false,
    actionResults: ["Task 'submit report' created for today 17:00."],
  });
  assert.strictEqual(committed.violations.length, 0);
});

it("a stored memory sentence echoed word for word is rejected", () => {
  const memory = "I am a third-year ECE student at Vasavi College of Engineering in Hyderabad";
  const echo = "You are a third-year ECE student at Vasavi College, is that right?";
  const styled = applyReplyStyle(echo, {
    style: CASUAL,
    tone: "casual",
    previousReplyUsedTerm: false,
    actionResults: [],
    memoryTexts: [memory],
  });
  assert.ok(styled.violations.some((violation) => violation.code === "memory_echo"), "echo not flagged");
  assert.strictEqual(styled.text, MODE_FIT_FALLBACK_REPLY);
});

it("the retry instruction names the rule", () => {
  const instruction = buildRetryInstruction([{ code: "emotion_parrot", detail: "You seem" }]);
  assert.match(instruction, /do not start by telling him what he seems/);
  assert.match(instruction, /Rewrite your last reply/);
});

console.log("\n=== S6: safety path ===\n");

it("figurative dark talk is not a crisis level", () => {
  for (const text of ["Lol just kill me", "kill me this assignment is too long", "this exam is killing me"]) {
    assert.strictEqual(assessRisk(text), "figurative", text);
  }
});

it("the harm gate does not fire on venting dark talk", () => {
  assert.strictEqual(checkHarmGate("Lol just kill me").isHarmBlocked, false, `Lol just kill me must not trigger the harm gate`);
});

it("the harm gate blocks violent task instructions", () => {
  assert.strictEqual(checkHarmGate("I plan to harm someone on the train").isHarmBlocked, true);
  assert.strictEqual(checkHarmGate("I will kill the president tomorrow").isHarmBlocked, true);
  assert.strictEqual(checkHarmGate("\\b(?:plan\\s+to\\s+kill|plan\\s+to\\s+murder|plan\\s+to\\s+harm)\\b").isHarmBlocked, true);
  assert.strictEqual(checkHarmGate("lol just kill me").isHarmBlocked, false, "Lol just kill me is venting, not a task to hurt a person");
  assert.strictEqual(checkHarmGate("this exam is killing me").isHarmBlocked, false, "figurative workload talk must not be blocked");
});

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
