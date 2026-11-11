/**
 * worker/groundingVerifier.ts - a narrow check that the reply did not invent facts.
 *
 * The audit found answers asserting a deleted memory and confidently wrong specifics. A
 * full fact-check needs another model; this is the cheap, deterministic slice that is
 * worth trusting: ids, dates, times and numbers must appear somewhere in what the model
 * was given.
 *
 * Deliberately NOT checked: weekday names, month names, product/model names, or the
 * assistant's own name. Those are language, not data, and blocking them would reject
 * correct answers ("Your class is at 09:00 on Monday").
 */

/**
 * The only reply this module may substitute, and only for a data question whose answer
 * is genuinely missing. CHAT, SUPPORT and ADVISE replies are never replaced with it:
 * "no record" as an answer to small talk is what broke the persona.
 */
export const UNGROUNDED_REPLY = "I don't have anything on that, sir.";

/** Task/memory/notification style identifiers regardless of prefix case. */
const ID_PATTERN = /\b(?:task|tsk|mem|msg|job|prop|dov|rec)_[A-Za-z0-9]{6,}\b/g;
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const TIME_PATTERN = /\b\d{1,2}:\d{2}\b/g;
const NUMBER_PATTERN = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\b/g;

export interface GroundingVerdict {
  grounded: boolean;
  /** The facts that could not be found in any source. */
  ungrounded: string[];
}

interface Span {
  start: number;
  end: number;
}

function collect(text: string, pattern: RegExp): { values: string[]; spans: Span[] } {
  const values: string[] = [];
  const spans: Span[] = [];
  // Fresh regex per call: the module-level ones are stateful with /g.
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    values.push(match[0]);
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return { values, spans };
}

/**
 * The facts in a reply that must be traceable to a source: ids, ISO dates, clock times and
 * plain numbers. Digits already claimed by an id/date/time are not re-read as numbers.
 */
export function extractCheckableFacts(reply: string): string[] {
  const text = typeof reply === "string" ? reply : "";
  if (!text) return [];

  const ids = collect(text, ID_PATTERN);
  const dates = collect(text, ISO_DATE_PATTERN);
  const times = collect(text, TIME_PATTERN);
  const claimed = [...ids.spans, ...dates.spans, ...times.spans];

  const numbers = collect(text, NUMBER_PATTERN).values.filter((value, index) => {
    const re = new RegExp(NUMBER_PATTERN.source, NUMBER_PATTERN.flags);
    let seen = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (seen === index) {
        const start = match.index;
        const end = start + match[0].length;
        return !claimed.some((span) => start < span.end && end > span.start);
      }
      seen += 1;
    }
    return true;
  });

  const facts = [...ids.values, ...dates.values, ...times.values, ...numbers];
  return [...new Set(facts.map((fact) => fact.trim()).filter(Boolean))];
}

/**
 * Canonical form for comparison: "09:00" and "9:00" are the same time, "1,200" and "1200"
 * the same number, and ids are case-insensitive. Compared as whole tokens, never as
 * substrings, so the "7" inside task_DEF987654321 cannot ground a claim of 7 tasks.
 */
function canonicalFact(fact: string): string {
  const cleaned = fact.trim().replace(/,/g, "");
  const time = /^(\d{1,2}):(\d{2})$/.exec(cleaned);
  if (time) return `${Number(time[1])}:${time[2]}`;
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) return String(Number(cleaned));
  return cleaned.toLowerCase();
}

/**
 * Verifies a reply against everything the model was given (context, system results and the
 * owner's own message). An empty source list means nothing can be grounded.
 */
export function verifyReplyGrounding(reply: string, sources: string[]): GroundingVerdict {
  const facts = extractCheckableFacts(reply);
  if (facts.length === 0) return { grounded: true, ungrounded: [] };

  const usable = (sources || []).filter((source): source is string => typeof source === "string" && source.length > 0);
  const known = new Set<string>();
  for (const source of usable) {
    for (const fact of extractCheckableFacts(source)) {
      known.add(canonicalFact(fact));
      // An ISO date also grounds its own day of month, so a reply may render
      // "2026-11-10" as "Tuesday, 10 November" without being called invented.
      const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fact);
      if (isoDate) known.add(String(Number(isoDate[3])));
    }
  }

  const ungrounded = facts.filter((fact) => !known.has(canonicalFact(fact)));
  return { grounded: ungrounded.length === 0, ungrounded };
}

/**
 * Removes the ungrounded facts themselves and keeps the surrounding prose.
 *
 * Used for CHAT/SUPPORT/ADVISE, where the words matter but an invented number must not
 * be sent. Deleting the whole sentence dead-ended real conversation ("You have 42 tasks
 * due and I like your plan." lost the encouragement too), so the fact is lifted out and
 * the sentence is kept. Returns an empty string only when nothing readable is left, so
 * the caller can use a mode-fit line instead of a "no record" line.
 */
export function stripUngroundedFacts(reply: string, ungrounded: string[]): string {
  const text = typeof reply === "string" ? reply : "";
  if (!text) return "";
  if (!ungrounded || ungrounded.length === 0) return text;

  let out = text;
  for (const fact of ungrounded) {
    if (!fact) continue;
    const escaped = fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), " ");
  }

  out = out
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,.!?;:])\s*([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,;:]+/, "")
    .trim();

  // Punctuation alone is not a reply.
  if (!/[\p{L}\p{N}]/u.test(out)) return "";
  return out;
}
