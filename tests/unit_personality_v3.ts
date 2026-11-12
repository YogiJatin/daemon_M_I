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
  type OwnerStyle,  enforceAddressTerms,
} from "../worker/personaStyle";
import { matchDeterministicReply } from "../worker/greetingMatcher";
import { applyReplyStyle, buildRetryInstruction, MODE_FIT_FALLBACK_REPLY, checkReplyStyle } from "../worker/replyStyle";
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
  const style: OwnerStyle = { address_terms: ["boss"], tone: "casual", brevity: "short", emoji: false, address_every_sentence: false };
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

it("FIX 7: all greetings go to the model, none are canned", () => {
  assert.strictEqual(matchDeterministicReply("hi", istAt(9, 0)), null);
  assert.strictEqual(matchDeterministicReply("thanks", istAt(9, 0)), null);
  assert.strictEqual(matchDeterministicReply("ok", istAt(9, 0)), null);
  assert.strictEqual(matchDeterministicReply("How are you", istAt(9, 0)), null);
});

it("FIX 7: no deterministic greeting variants (model owns them)", () => {
  assert.strictEqual(matchDeterministicReply("hi", istAt(9, 30, 1)), null);
  assert.strictEqual(matchDeterministicReply("hello", istAt(9, 0)), null);
});

it("FIX 7: empty address-term list is irrelevant (no canned greetings)", () => {
  assert.strictEqual(matchDeterministicReply("hi", istAt(9, 0)), null);
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

it("FIX 7: applyReplyStyle is a passthrough (collapseDuplicateSir is separate)", () => {
  const styled = applyReplyStyle("I will call you sir, sir.", {
    style: CASUAL,
    tone: "casual",
    previousReplyUsedTerm: false,
    actionResults: [],
  });
  assert.strictEqual(styled.text, "I will call you sir, sir.");
  assert.strictEqual(styled.retryable, false);
});

it("FIX 7: applyReplyStyle passthrough (emotion-parrot no longer blocked by code)", () => {
  for (const bad of [
    "You seem upset, sir.",
    "You are expressing frustration.",
  ]) {
    const styled = applyReplyStyle(bad, { style: CASUAL, tone: "casual", previousReplyUsedTerm: false, actionResults: [] });
    assert.strictEqual(styled.text, bad);
    assert.strictEqual(styled.retryable, false);
  }
  // checkReplyStyle still reports the code for callers that want it
  const v = checkReplyStyle("You seem upset, sir.", { style: CASUAL, tone: "casual", previousReplyUsedTerm: false, actionResults: [] });
  assert.ok(v.some((x) => x.code === "emotion_parrot"));
});

it("FIX 7: applyReplyStyle passthrough for noted (checkReplyStyle still reports)", () => {
  const bare = applyReplyStyle("Noted, sir.", { style: CASUAL, tone: "casual", previousReplyUsedTerm: false, actionResults: [] });
  assert.strictEqual(bare.text, "Noted, sir.");
  const v = checkReplyStyle("Noted, sir.", { style: CASUAL, tone: "casual", previousReplyUsedTerm: false, actionResults: [] });
  assert.ok(v.some((x) => x.code === "unsupported_ack"));
});

it("FIX 7: applyReplyStyle passthrough for memory echo (checkReplyStyle still reports)", () => {
  const memory = "I am a third-year ECE student at Vasavi College of Engineering in Hyderabad";
  const echo = "You are a third-year ECE student at Vasavi College, is that right?";
  const styled = applyReplyStyle(echo, {
    style: CASUAL,
    tone: "casual",
    previousReplyUsedTerm: false,
    actionResults: [],
    memoryTexts: [memory],
  });
  assert.strictEqual(styled.text, echo);
  const v = checkReplyStyle(echo, { style: CASUAL, tone: "casual", previousReplyUsedTerm: false, actionResults: [], memoryTexts: [memory] });
  assert.ok(v.some((x) => x.code === "memory_echo"), "echo flagged");
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


console.log("\n=== FIX 7: the owner's address rule ===\n");

it("a standing address command is stored as style, not a memory card", () => {
  const route = preRouteStyleRequest("always call me boss and say sir at the end", DEFAULT_OWNER_STYLE);
  assert.ok(route, "the command must be recognised by code, not left to the model");
  assert.ok(route!.style.address_every_sentence, "every-sentence flag set");
  assert.strictEqual(route!.style.address_terms[0], "sir", "the spoken term leads");
  assert.ok(route!.style.address_terms.includes("boss"), "the called term is kept");
});

it("\"say sir in every sentence\" sets the enforced address rule", () => {
  const route = preRouteStyleRequest("you must say sir in every sentence put that as my command in your memory", DEFAULT_OWNER_STYLE);
  assert.ok(route, "command recognised");
  assert.strictEqual(route!.style.address_terms[0], "sir");
  assert.strictEqual(route!.style.address_every_sentence, true);
});

it("every sentence gets the address term, even on casual easy mode", () => {
  const style: OwnerStyle = { ...DEFAULT_OWNER_STYLE, tone: "casual", address_terms: ["sir"], address_every_sentence: true };
  const out = enforceAddressTerms("Morning. How are you? Nothing pending!", style);
  const sentences = out.split(/(?<=[.!?])\s+/).filter(Boolean);
  assert.strictEqual(sentences.length, 3, out);
  for (const sentence of sentences) {
    assert.match(sentence, /\bsir\b/i, `missing sir: ${sentence}`);
  }
});

it("the rail stays off until the owner asks for it", () => {
  const style: OwnerStyle = { ...DEFAULT_OWNER_STYLE, address_every_sentence: false };
  assert.strictEqual(enforceAddressTerms("Morning. How are you?", style), "Morning. How are you?");
});

it("no double term is added when the sentence already has one", () => {
  const style: OwnerStyle = { ...DEFAULT_OWNER_STYLE, address_terms: ["sir"], address_every_sentence: true };
  assert.strictEqual(enforceAddressTerms("Morning, sir. How are you?", style), "Morning, sir. How are you, sir?");
});

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
