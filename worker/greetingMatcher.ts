/**
 * worker/greetingMatcher.ts - deterministic replies for bare greetings, thanks and acks.
 *
 * Production showed "Yoo" and "What" answered with "No data.", because both went to the
 * classifier and came back as a failed lookup. A greeting is not a lookup. These
 * messages are answered by code, in zero LLM calls, so they are also immune to provider
 * outages.
 *
 * Scope is deliberately tiny (persona v3): the WHOLE message must be a bare greeting,
 * thanks or acknowledgement, at most three words, with no question mark. Anything else,
 * including "how are you" and every question, goes to the LLM in CHAT mode: canned
 * answers to real conversation are what made the bot feel dead.
 *
 * Variants: at least four per tone, time-of-day aware in IST, never the same one twice
 * in a row.
 */

import { resolveTone, type OwnerStyle, DEFAULT_OWNER_STYLE } from "./personaStyle";

export type DeterministicKind = "greeting" | "thanks" | "acknowledgement";

export interface DeterministicReply {
  reply: string;
  kind: DeterministicKind;
}

export interface DeterministicOptions {
  style?: OwnerStyle;
  /** The previous assistant reply, so the same variant is never sent twice running. */
  previousReply?: string | null;
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
  "how are",
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

const THANKS = new Set(["thanks", "thank you", "thx", "ty", "thank u", "thanks a lot", "thank you so much"]);

const ACKNOWLEDGEMENTS = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "cool",
  "fine",
  "alright",
  "got it",
  "hmm",
  "hm",
  "oh",
  "ah",
  "i see",
  "right",
  "yes",
  "yeah",
  "ya",
  "yep",
  "no",
  "nope",
]);

type PartOfDay = "morning" | "afternoon" | "evening" | "night";

const GREETING_VARIANTS: Record<"casual" | "formal", Record<PartOfDay, string[]>> = {
  casual: {
    morning: ["Morning, {term}.", "Morning. What's up, {term}?", "Hey, morning, {term}.", "Morning, {term}. Sleep okay?"],
    afternoon: ["Afternoon, {term}.", "Hey, afternoon, {term}.", "Afternoon, {term}. What's up?", "Afternoon, {term}. How's the day going?"],
    evening: ["Evening, {term}.", "Hey, evening, {term}.", "Evening, {term}. What's up?", "Evening, {term}. Long day?"],
    night: ["Night, {term}.", "Late night, {term}.", "Night, {term}. Still up?", "Night, {term}. Get some sleep."],
  },
  formal: {
    morning: ["Good morning, {term}.", "Good morning, {term}. How can I help?", "Morning, {term}.", "Good morning, {term}. What do you need?"],
    afternoon: ["Good afternoon, {term}.", "Good afternoon, {term}. How can I help?", "Afternoon, {term}.", "Good afternoon, {term}. What do you need?"],
    evening: ["Good evening, {term}.", "Good evening, {term}. How can I help?", "Evening, {term}.", "Good evening, {term}. What do you need?"],
    night: ["Good night, {term}.", "Good night, {term}. Rest well.", "Night, {term}.", "Good night, {term}. Anything else before you sleep?"],
  },
};

const THANKS_VARIANTS: Record<"casual" | "formal", string[]> = {
  casual: ["Anytime.", "Anytime, {term}.", "No problem.", "Sure thing."],
  formal: ["Anytime, {term}.", "You're welcome, {term}.", "Of course, {term}.", "My pleasure, {term}."],
};

const ACK_VARIANTS: Record<"casual" | "formal", string[]> = {
  casual: ["Right.", "Cool.", "Got you.", "Okay."],
  formal: ["Right, {term}.", "Very good, {term}.", "Understood, {term}.", "As you wish, {term}."],
};

export function partOfDayIST(now: Date): PartOfDay {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now)
  );
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

/** Small deterministic hash so the same message in the same hour maps to one variant. */
function stableIndex(seed: string, length: number): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % Math.max(1, length);
}

function fill(template: string, style: OwnerStyle): string {
  const term = style.address_terms[0];
  if (!template.includes("{term}")) return template;
  if (!term) {
    // No address term allowed: drop the placeholder and tidy the sentence.
    return template
      .replace(/,\s*\{term\}/g, "")
      .replace(/\{term\}/g, "")
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/^([A-Z][a-z]+)\s+\./, "$1.")
      .trim();
  }
  return template.replace(/\{term\}/g, term);
}

/**
 * Picks a variant. `rotation` is the IST day of month, so consecutive days are guaranteed
 * to walk through every variant instead of hashing to the same one for weeks.
 */
function pickVariant(
  variants: string[],
  style: OwnerStyle,
  seed: string,
  rotation: number,
  previousReply?: string | null,
): string {
  const filled = variants.map((variant) => fill(variant, style));
  let index = (stableIndex(seed, filled.length) + rotation) % filled.length;
  if (previousReply && filled[index] === previousReply.trim() && filled.length > 1) {
    index = (index + 1) % filled.length;
  }
  return filled[index];
}

/** IST calendar date for the variant seed, independent of the Worker's own timezone. */
function istDateParts(now: Date): { dateKey: string; dayNumber: number } {
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const dayNumber = Number(dateKey.slice(-2)) || 1;
  return { dateKey, dayNumber };
}

/** Deterministic replies only ever answer three words or fewer, and never a question. */
function isDeterministicShaped(text: string): boolean {
  if (/[?]/.test(text)) return false;
  const words = normalizeChatFragment(text).split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 3;
}

/**
 * Returns a reply when the whole message is bare small talk, otherwise null.
 */
export function matchDeterministicReply(
  text: string,
  now: Date = new Date(),
  options: DeterministicOptions = {}
): DeterministicReply | null {
  const normalized = normalizeChatFragment(text);
  if (!normalized) return null;
  if (!isDeterministicShaped(text)) return null;

  // A request never gets a canned greeting, however short it is.
  if (REQUEST_MARKERS.some((marker) => normalized.includes(marker))) return null;

  const style = options.style ?? DEFAULT_OWNER_STYLE;
  const tone = resolveTone(style);
  const { dateKey, dayNumber } = istDateParts(now);
  const bucket = `${dateKey}|${tone}|${normalized}`;
  const previousReply = options.previousReply ?? null;

  if (GREETINGS.has(normalized)) {
    const part = partOfDayIST(now);
    return {
      reply: pickVariant(GREETING_VARIANTS[tone][part], style, bucket, dayNumber, previousReply),
      kind: "greeting",
    };
  }

  if (THANKS.has(normalized)) {
    return {
      reply: pickVariant(THANKS_VARIANTS[tone], style, bucket, dayNumber, previousReply),
      kind: "thanks",
    };
  }

  if (ACKNOWLEDGEMENTS.has(normalized)) {
    return {
      reply: pickVariant(ACK_VARIANTS[tone], style, bucket, dayNumber, previousReply),
      kind: "acknowledgement",
    };
  }

  return null;
}
