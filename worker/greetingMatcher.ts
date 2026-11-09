/**
 * worker/greetingMatcher.ts - deterministic replies for greetings and bare fragments.
 *
 * Production showed "Yoo" and "What" answered with "No data.", because both went to the
 * classifier and came back as a failed lookup. A greeting is not a lookup, and a bare
 * "what" is not a question with a missing answer. These messages are answered by code,
 * in zero LLM calls, so they are also immune to provider outages.
 *
 * Scope is deliberately tiny: the WHOLE message must be one of the known shapes. Any
 * message carrying a request ("yo add task x", "what time is my class") is not matched
 * and continues to the classifier.
 */

export type DeterministicKind = "greeting" | "acknowledgement" | "fragment";

export interface DeterministicReply {
  reply: string;
  kind: DeterministicKind;
}

/** Lowercase, strip emoji/punctuation, collapse whitespace. */
export function normalizeChatFragment(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that make a message a request even when it starts like small talk. */
const REQUEST_MARKERS = [
  "add",
  "remind",
  "task",
  "reminder",
  "schedule",
  "delete",
  "forget",
  "remember",
  "cancel",
  "move",
  "reschedule",
  "plan",
  "when",
  "what time",
  "how many",
  "did i",
  "have i",
  "show",
  "list",
];

const GREETINGS = new Set([
  "hi",
  "hello",
  "hey",
  "heyy",
  "yo",
  "yoo",
  "yooo",
  "sup",
  "wassup",
  "whats up",
  "namaste",
  "namaskaram",
  "hola",
  "morning",
  "good morning",
  "afternoon",
  "good afternoon",
  "evening",
  "good evening",
  "good night",
  "gm",
  "gn",
]);

const ACKNOWLEDGEMENTS = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "cool",
  "fine",
  "alright",
  "got it",
  "noted",
  "thanks",
  "thank you",
  "thx",
  "ty",
  "np",
  "hmm",
  "hm",
  "oh",
  "ah",
  "i see",
]);

const FRAGMENTS = new Set([
  "what",
  "who",
  "why",
  "how",
  "when",
  "where",
  "which",
  "huh",
  "eh",
  "?",
  "??",
  "what?",
  "who?",
  "why?",
]);

function greetingFor(normalized: string, now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now)
  );
  const partOfDay = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  if (normalized === "good night" || normalized === "gn") return "Sir.";
  return `${partOfDay}, sir.`;
}

/**
 * Returns a reply when the whole message is small talk, otherwise null.
 */
export function matchDeterministicReply(text: string, now: Date = new Date()): DeterministicReply | null {
  const normalized = normalizeChatFragment(text);
  if (!normalized) return null;

  // A request never gets a canned greeting, however short it is.
  if (REQUEST_MARKERS.some((marker) => normalized.includes(marker))) return null;

  if (GREETINGS.has(normalized)) {
    return { reply: greetingFor(normalized, now), kind: "greeting" };
  }

  if (ACKNOWLEDGEMENTS.has(normalized)) {
    return { reply: "Noted.", kind: "acknowledgement" };
  }

  if (FRAGMENTS.has(normalized)) {
    // A bare interrogative is not a command: ask what he needs without instructing him.
    return { reply: "I didn't catch that, sir. What do you need?", kind: "fragment" };
  }

  return null;
}
