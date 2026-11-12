/**
 * worker/greetingMatcher.ts - FIX 7: the scripted greeting layer is gone.
 *
 * Production showed the bot answering "Yoo" with a canned "Morning, sir." and
 * "What" with "No data." Both were code-written replies that read like a form
 * letter. Under FIX 7 the model writes every conversational reply; code only
 * performs actions after an owner tap, supplies facts, and keeps safety rails.
 *
 * This module keeps the stable shape its callers and tests import. It never
 * produces a reply: matchDeterministicReply always returns null, so greetings,
 * thanks and acknowledgements reach the model like any other conversation.
 */

export type DeterministicKind = "greeting" | "thanks" | "acknowledgement";

export interface DeterministicReply {
  reply: string;
  kind: DeterministicKind;
}

export interface DeterministicOptions {
  /** Kept for call-site compatibility; unused now that no reply is generated. */
  style?: unknown;
  /** Kept for call-site compatibility; unused now that no reply is generated. */
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

/**
 * FIX 7: always null. Kept so existing call sites keep compiling while the
 * model-owned reply path replaces the old canned greetings, thanks and acks.
 */
export function matchDeterministicReply(
  _text: string,
  _now: Date = new Date(),
  _options: DeterministicOptions = {}
): DeterministicReply | null {
  return null;
}
