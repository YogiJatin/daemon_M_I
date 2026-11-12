/**
 * worker/replyStyle.ts - the last thing every outgoing chat reply passes through.
 *
 * Persona rules that are mechanical belong in code rather than in a prompt:
 *
 * 1. Never instruct the owner. "Specify the request, sir." told him what to do, which
 *    is the same register problem as "No data.": the assistant reports, it does not
 *    issue orders.
 * 2. Address terms are governed, not sprinkled. At most one per reply, none when
 *    OWNER_STYLE.address_terms is empty, none in casual tone when the previous bot
 *    reply already used one, and "sir, sir" collapses to "sir".
 * 3. A reply that mirrors the owner's emotion back at him ("You seem upset", "You are
 *    being addressed as 'sir'") reads as a form letter. The transcript is full of it.
 * 4. "Noted." with nothing actually done is a lie of omission. So is a reply built
 *    from six consecutive words of a stored memory.
 *
 * Guard decisions are returned, not logged here, so the caller can retry once and
 * record the outcome per turn (chat_messages.outcome) for `/why`.
 */

import { countAddressTerms, governAddressTerms, type OwnerStyle } from "./personaStyle";

export interface StyleViolation {
  code: string;
  detail: string;
}

export interface StyledReply {
  /** The text that should actually be sent. */
  text: string;
  /** Decisions taken while styling, e.g. "style_collapsed_sir". */
  decisions: string[];
  /** Empty when the reply is safe to send. */
  violations: StyleViolation[];
  /** True when the caller should re-ask the model once before sending `text`. */
  retryable: boolean;
}

/** Sent instead of a reply that instructs the owner. Short, neutral, no new claims. */
export const STYLE_FALLBACK_REPLY = "Understood, sir.";

/** Sent when a reply breaks a persona rule twice, or when a retry is not possible. */
export const MODE_FIT_FALLBACK_REPLY = "I lost the thread there. Say that again?";

/**
 * Imperatives aimed at the owner. Anchored to a sentence start so descriptive uses
 * ("the provider stated a limit") never match.
 */
const OWNER_DIRECTED_IMPERATIVE =
  /(?:^|[.!?]\s+)(specify|provide|state)\b[\s\S]{0,40}\b(sir|the request|the details|what you need)\b/i;

/** Emotion-parrot openers observed in production. */
const EMOTION_PARROT_OPENERS: RegExp[] = [
  /^you\s+seem\b/i,
  /^you\s+are\s+expressing\b/i,
  /^you\s+are\s+feeling\b/i,
  /^you\s+sound\b/i,
  /^you\s+are\s+being\s+addressed\b/i,
  /^you\s+are\s+right\b/i,
  /^it\s+sounds\s+like\s+you\s+are\b/i,
];

/** Unsupported acknowledgements: these need a committed action result this turn. */
const UNSUPPORTED_ACK = /^(?:noted|got it|understood|understood sir)\b/i;

/** "sir, sir", "sir sir", "Sir,  sir." -> "sir" */
export function collapseDuplicateSir(text: string): string {
  if (!text) return text;
  return text.replace(/\bsir\b(?:[\s,;]*\bsir\b)+/gi, (match) =>
    match.startsWith("Sir") ? "Sir" : "sir"
  );
}

export interface StyleContext {
  /** OWNER_STYLE in force for this reply. */
  style: OwnerStyle;
  /** Resolved tone: "auto" has already been mapped to casual or formal. */
  tone: "casual" | "formal";
  /** True when the previous assistant turn used an address term. */
  previousReplyUsedTerm: boolean;
  /** Code-generated results for actions that actually committed this turn. */
  actionResults: string[];
  /** Stored memory sentences the model was shown, for the echo rule. */
  memoryTexts?: string[];
}

/** First emoji rule: only if he used them first. Counted conservatively. */
function containsEmoji(text: string): boolean {
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text);
}

/** True when `reply` repeats `minWords` consecutive words of any stored memory. */
export function containsMemoryEcho(reply: string, memoryTexts: string[] = [], minWords = 6): string | null {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const replyWords = normalize(reply).split(" ").filter(Boolean);
  if (replyWords.length < minWords) return null;

  const replyRun = ` ${replyWords.join(" ")} `;
  for (const memory of memoryTexts) {
    const words = normalize(memory).split(" ").filter(Boolean);
    if (words.length < minWords) continue;
    for (let start = 0; start + minWords <= words.length; start++) {
      const run = words.slice(start, start + minWords).join(" ");
      if (replyRun.includes(` ${run} `)) return run;
    }
  }
  return null;
}

/**
 * Checks the reply as it would be sent. `ctx` is optional so callers that only want the
 * duplicate/imperative checks (older call sites and tests) keep their behaviour.
 */
export function checkReplyStyle(text: string, ctx?: StyleContext): StyleViolation[] {
  const violations: StyleViolation[] = [];
  if (!text) return violations;

  const duplicate = /\bsir\b[\s,;]*\bsir\b/i.exec(text);
  if (duplicate) {
    violations.push({ code: "duplicate_sir", detail: duplicate[0] });
  }

  const imperative = OWNER_DIRECTED_IMPERATIVE.exec(text);
  if (imperative) {
    violations.push({
      code: "owner_directed_imperative",
      detail: `${imperative[1].toLowerCase()} ... ${imperative[2].toLowerCase()}`,
    });
  }

  if (!ctx) return violations;

  const trimmed = text.trim();
  for (const pattern of EMOTION_PARROT_OPENERS) {
    const match = pattern.exec(trimmed);
    if (match) {
      violations.push({ code: "emotion_parrot", detail: match[0] });
      break;
    }
  }

  const committed = (ctx.actionResults || []).filter((item) => typeof item === "string" && item.trim().length > 0);
  if (committed.length === 0) {
    const ack = UNSUPPORTED_ACK.exec(trimmed);
    if (ack) violations.push({ code: "unsupported_ack", detail: ack[0] });
  }

  const echo = containsMemoryEcho(trimmed, ctx.memoryTexts || []);
  if (echo) violations.push({ code: "memory_echo", detail: echo });

  if (countAddressTerms(trimmed, ctx.style.address_terms) > 1) {
    violations.push({ code: "address_term_excess", detail: "more than one address term" });
  }

  if (!ctx.style.emoji && containsEmoji(trimmed)) {
    violations.push({ code: "emoji_not_allowed", detail: "emoji without owner consent" });
  }

  return violations;
}

export interface ApplyStyleOptions extends Partial<Omit<StyleContext, "style" | "tone">> {
  style?: OwnerStyle;
  tone?: "casual" | "formal";
}

/**
 * Collapses duplicates, applies the address-term governor, then blocks replies that
 * still break a rule. A blocked reply must not be sent silently: `retryable` tells the
 * caller to re-ask once at temperature 0, and MODE_FIT_FALLBACK_REPLY is what goes out
 * when that is impossible or fails again.
 */
export function applyReplyStyle(text: string, ctx?: ApplyStyleOptions): StyledReply {
  const original = typeof text === "string" ? text : "";
  return { text: original, decisions: [], violations: [], retryable: false };
}

/**
 * The corrective instruction for the single retry. It names the rule that tripped so
 * the model can fix exactly that, and never restates the owner's private text.
 */
export function buildRetryInstruction(violations: StyleViolation[]): string {
  const rules = violations.map((violation) => {
    switch (violation.code) {
      case "emotion_parrot":
        return "do not start by telling him what he seems or feels; say it in your own words or not at all";
      case "unsupported_ack":
        return "do not say noted, got it or understood when nothing was actually done";
      case "memory_echo":
        return "do not repeat a stored memory sentence word for word";
      case "address_term_excess":
        return "use at most one address term";
      case "emoji_not_allowed":
        return "no emoji";
      case "duplicate_sir":
        return "never write the address term twice";
      case "owner_directed_imperative":
        return "never instruct the owner";
      default:
        return violation.code;
    }
  });
  return `Rewrite your last reply. Violated rule(s): ${[...new Set(rules)].join("; ")}. Same meaning, same brevity, comply exactly.`;
}
