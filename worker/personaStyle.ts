/**
 * worker/personaStyle.ts - OWNER_STYLE parse, apply, render, pre-router and term governing.
 *
 * OWNER_STYLE is the only place the voice parameters live, so the live model never has to
 * guess the tone or the address term. It is stored in settings under
 * PERSONA_STYLE_SETTING_KEY and injected into the prompt from telegramAssistant.ts.
 *
 * Every enum is closed and validated on entry. Invalid input falls back to the default
 * value, never to a half-applied shape, so a bad setting cannot leave the owner with a
 * broken voice.
 */

export type Tone = "auto" | "casual" | "formal";
export type Brevity = "short" | "normal" | "detailed";

export interface OwnerStyle {
  address_terms: string[];
  tone: Tone;
  brevity: Brevity;
  emoji: boolean;
  /** True when the owner asked to be addressed in every sentence, not just some replies. */
  address_every_sentence: boolean;
}

export const PERSONA_STYLE_SETTING_KEY = "persona_style";

export const DEFAULT_OWNER_STYLE: OwnerStyle = {
  address_terms: ["sir", "boss", "master"],
  tone: "auto",
  brevity: "normal",
  emoji: false,
  address_every_sentence: false,
};

const VALID_TONES: Tone[] = ["auto", "casual", "formal"];
const VALID_BREVITIES: Brevity[] = ["short", "normal", "detailed"];

function isTone(value: unknown): value is Tone {
  return typeof value === "string" && VALID_TONES.indexOf(value as Tone) !== -1;
}

function isBrevity(value: unknown): value is Brevity {
  return typeof value === "string" && VALID_BREVITIES.indexOf(value as Brevity) !== -1;
}

/** Strip punctuation and whitespace; keep letters, digits, spaces, hyphen and apostrophe. */
export function cleanTerm(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const source = String(raw).normalize("NFKC").trim();
  if (!source) return null;
  // An address term is a word. Markup, paths, URLs, digits and control characters are
  // rejected outright instead of being scrubbed into something that looks harmless.
  if (/[<>{}[\]\\/|`$@#*+=~^%]/.test(source)) return null;
  if (/[\p{N}]/u.test(source)) return null;

  const cleaned = source
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\p{L} '-]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return null;
  if (cleaned.length > 24) return null;
  if (!/^[\p{L}][\p{L} '-]*$/u.test(cleaned)) return null;
  return cleaned;
}

function cleanTermList(rawTerms: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(rawTerms)) return out;
  for (const raw of rawTerms) {
    if (typeof raw !== "string") continue;
    const cleaned = cleanTerm(raw);
    if (cleaned && out.indexOf(cleaned) === -1) out.push(cleaned);
  }
  return out;
}

/**
 * Tolerant parse: bad JSON or missing fields fall back to defaults. Address terms are
 * cleaned and de-duplicated; invalid terms are dropped.
 */
export function parseOwnerStyle(raw: unknown): OwnerStyle {
  let parsed: any = null;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  } else if (typeof raw === "object" && raw != null) {
    parsed = raw;
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      address_terms: [...DEFAULT_OWNER_STYLE.address_terms],
      tone: DEFAULT_OWNER_STYLE.tone,
      brevity: DEFAULT_OWNER_STYLE.brevity,
      emoji: DEFAULT_OWNER_STYLE.emoji,
      address_every_sentence: DEFAULT_OWNER_STYLE.address_every_sentence,
    };
  }

  const rawTerms = Array.isArray(parsed.address_terms)
    ? parsed.address_terms
    : Array.isArray(parsed.terms)
      ? parsed.terms
      : null;
  const terms = cleanTermList(rawTerms);

  return {
    address_terms:
      terms.length > 0 ? terms : [...DEFAULT_OWNER_STYLE.address_terms],
    tone: isTone(parsed.tone) ? parsed.tone : DEFAULT_OWNER_STYLE.tone,
    brevity: isBrevity(parsed.brevity) ? parsed.brevity : DEFAULT_OWNER_STYLE.brevity,
    emoji: typeof parsed.emoji === "boolean" ? parsed.emoji : DEFAULT_OWNER_STYLE.emoji,
    address_every_sentence:
      typeof parsed.address_every_sentence === "boolean"
        ? parsed.address_every_sentence
        : DEFAULT_OWNER_STYLE.address_every_sentence,
  };
}

export interface StylePatch {
  tone?: unknown;
  brevity?: unknown;
  emoji?: unknown;
  address_terms?: unknown;
  add_terms?: unknown;
  remove_terms?: unknown;
  address_every_sentence?: unknown;
}

export interface StyleUpdateResult {
  style: OwnerStyle;
  applied: string[];
  rejected: string[];
}

/**
 * The style_update action as the classifier emits it. Field-level validation happens in
 * applyStyleUpdate, so every field is a plain string/boolean here.
 */
export interface StyleUpdate {
  type?: "style_update";
  tone?: string;
  brevity?: string;
  emoji?: boolean;
  address_terms?: string[];
  address_every_sentence?: boolean;
}

/**
 * Validated merge of a patch onto the current style. Unknown or invalid values are
 * rejected and left out, so the caller can report exactly what changed.
 */
export function applyStyleUpdate(current: OwnerStyle, patch: StylePatch): StyleUpdateResult {
  const applied: string[] = [];
  const rejected: string[] = [];
  const style: OwnerStyle = {
    address_terms: [...current.address_terms],
    tone: current.tone,
    brevity: current.brevity,
    emoji: current.emoji,
    address_every_sentence: current.address_every_sentence,
  };

  if (patch.tone !== undefined) {
    if (isTone(patch.tone)) {
      style.tone = patch.tone;
      applied.push(`tone=${patch.tone}`);
    } else {
      rejected.push("tone");
    }
  }

  if (patch.brevity !== undefined) {
    if (isBrevity(patch.brevity)) {
      style.brevity = patch.brevity;
      applied.push(`brevity=${patch.brevity}`);
    } else {
      rejected.push("brevity");
    }
  }

  if (patch.emoji !== undefined) {
    if (typeof patch.emoji === "boolean") {
      style.emoji = patch.emoji;
      applied.push(`emoji=${patch.emoji ? "on" : "off"}`);
    } else {
      rejected.push("emoji");
    }
  }

  if (patch.address_terms !== undefined) {
    const raw = Array.isArray(patch.address_terms) ? patch.address_terms : null;
    if (raw === null) {
      rejected.push("address_terms");
    } else if (raw.length === 0) {
      // An explicit empty list is a deliberate clear.
      style.address_terms = [];
      applied.push("address_terms=[]");
    } else {
      const terms = cleanTermList(raw);
      if (terms.length === 0) {
        // Nothing usable was supplied: the request is rejected and no term survives.
        style.address_terms = [];
        rejected.push("address_terms");
      } else {
        style.address_terms = terms;
        applied.push(`address_terms=[${terms.join(", ")}]`);
      }
    }
  }

  if (patch.add_terms !== undefined) {
    const terms = cleanTermList(patch.add_terms);
    if (terms.length === 0) {
      rejected.push("add_terms");
    } else {
      for (const term of terms) {
        if (style.address_terms.indexOf(term) === -1) style.address_terms.push(term);
      }
      applied.push(`add_terms=[${terms.join(", ")}]`);
    }
  }

  if (patch.remove_terms !== undefined) {
    const terms = cleanTermList(patch.remove_terms);
    if (terms.length === 0) {
      rejected.push("remove_terms");
    } else {
      for (const term of terms) {
        const idx = style.address_terms.indexOf(term);
        if (idx !== -1) style.address_terms.splice(idx, 1);
      }
      applied.push(
        style.address_terms.length === 0 ? "address_terms=[]" : `remove_terms=[${terms.join(", ")}]`,
      );
    }
  }

  if (patch.address_every_sentence !== undefined) {
    if (typeof patch.address_every_sentence === "boolean") {
      style.address_every_sentence = patch.address_every_sentence;
      applied.push(`address_every_sentence=${patch.address_every_sentence}`);
    } else {
      rejected.push("address_every_sentence");
    }
  }

  return { style, applied, rejected };
}

/**
 * Code-owned confirmation for a style change. The model never writes this line, so the
 * reply cannot claim a change the code did not make.
 */
export function describeStyleUpdate(applied: string[]): string {
  if (!applied || applied.length === 0) return "Done.";

  const parts: string[] = [];
  for (const entry of applied) {
    if (entry === "address_terms=[]") continue;
    if (entry.startsWith("tone=")) {
      const value = entry.slice("tone=".length);
      parts.push(`${value.charAt(0).toUpperCase()}${value.slice(1)} tone`);
      continue;
    }
    if (entry.startsWith("brevity=")) {
      const value = entry.slice("brevity=".length);
      if (value === "short") parts.push("Shorter replies");
      else if (value === "detailed") parts.push("More detail");
      else parts.push("Normal length");
      continue;
    }
    if (entry.startsWith("emoji=")) {
      parts.push(entry.endsWith("on") ? "Emoji on" : "Emoji off");
      continue;
    }
    if (entry.startsWith("address_terms=[") || entry.startsWith("add_terms=[")) {
      const inner = entry.slice(entry.indexOf("[") + 1, entry.lastIndexOf("]"));
      if (inner) parts.push(`Address term: ${inner}`);
      continue;
    }
    if (entry.startsWith("address_every_sentence=")) {
      parts.push(entry.endsWith("true") ? "Address term in every sentence" : "Address term optional again");
      continue;
    }
    if (entry.startsWith("remove_terms=[")) {
      const inner = entry.slice(entry.indexOf("[") + 1, entry.lastIndexOf("]"));
      if (inner) parts.push(`Address term removed: ${inner}`);
      continue;
    }
    parts.push(entry);
  }

  if (parts.length === 0) return "Done.";
  return `${parts.join(". ")}.`;
}

/** "auto" mirrors the owner; the deterministic paths need a concrete register. */
export function resolveTone(style: OwnerStyle): "casual" | "formal" {
  if (style.tone === "formal") return "formal";
  return "casual";
}

function normalizeCommand(text: string): string {
  return (text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^\p{L}\p{N}\s']+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A message that also asks for work must reach the classifier, so any work word cancels the
 * style route.
 */
const WORK_WORDS = new RegExp(
  [
    "add",
    "remind",
    "reminder",
    "task",
    "tasks",
    "todo",
    "schedule",
    "delete",
    "remove\\s+the\\s+task",
    "forget",
    "remember",
    "cancel",
    "reschedule",
    "move",
    "plan",
    "when",
    "what\\s+time",
    "how\\s+many",
    "how\\s+are",
    "did\\s+i",
    "have\\s+i",
    "show",
    "list",
    "tomorrow",
    "today",
    "tonight",
    "this\\s+week",
    "next\\s+week",
    "at\\s+\\d",
    "by\\s+\\d",
  ].join("|"),
  "i",
);

export interface StyleRouteResult {
  style: OwnerStyle;
  reply: string;
  applied: string[];
}

/**
 * Deterministic style pre-router. Returns null unless the whole message is a style command,
 * so a work request is never swallowed.
 */
export function preRouteStyleRequest(text: string, current: OwnerStyle): StyleRouteResult | null {
  const normalized = normalizeCommand(text);
  if (!normalized) return null;
  if (WORK_WORDS.test(normalized)) return null;

  const finish = (patch: StylePatch): StyleRouteResult | null => {
    const result = applyStyleUpdate(current, patch);
    if (result.applied.length === 0) return null;
    return {
      style: result.style,
      reply: describeStyleUpdate(result.applied),
      applied: result.applied,
    };
  };

  // "sir anaku", "sir ana nu", "sir vaddu" - Telugu/Hinglish "don't call me sir".
  if (/^(?:sir\s+)?(?:anaku|ana\s+nu|vaddu|odhu)$/.test(normalized.replace(/^sir\s+/, ""))) {
    return finish({ address_terms: [] });
  }

  // "stop calling me sir", "don't call me master", "no more sir".
  const removeMatch = normalized.match(
    /^(?:please\s+)?(?:stop\s+calling\s+me|don'?t\s+call\s+me|do\s+not\s+call\s+me|no\s+more|calling\s+me\s+not)\s+(\S+)/,
  );
  if (removeMatch) {
    // Rejecting a term clears the list: the owner said stop, so nothing remains to guess.
    return finish({ address_terms: [] });
  }

  // "call me boss", "call me boss from now on".
  const renameMatch = normalized.match(/^call\s+me\s+(\S+?)(?:\s+from\s+now(?:\s+on)?)?$/);
  if (renameMatch) {
    return finish({ address_terms: [renameMatch[1]] });
  }

  // A standing address rule anywhere in the sentence:
  // "always call me boss and say sir at the end", "you must say sir in every sentence",
  // "always address me as sir", "put that as my command".
  const addressRule = matchAddressRule(normalized);
  if (addressRule) {
    const patch: StylePatch = {};
    if (addressRule.term) {
      patch.address_terms = addressRule.secondary
        ? [addressRule.term, addressRule.secondary]
        : [addressRule.term];
    }
    if (addressRule.everySentence) patch.address_every_sentence = true;
    if (patch.address_terms !== undefined || patch.address_every_sentence !== undefined) {
      return finish(patch);
    }
  }

  if (
    /(?:talk|speak|chat)\s+(?:to\s+me\s+)?casual|be\s+casual|don'?t\s+be\s+so\s+uptight|just\s+be\s+casual|casual\s+ga\s+(?:matladu|matlad|maatladu)|casual\s+ga\s+batlu|casual\s+tone/.test(
      normalized,
    )
  ) {
    return finish({ tone: "casual" });
  }

  if (/be\s+formal|talk\s+formally|formal\s+tone|more\s+formal|be\s+a\s+bit\s+more\s+formal/.test(normalized)) {
    return finish({ tone: "formal" });
  }

  if (
    /shorter\s+repl(?:y|ies)|keep\s+(?:it|replies|answers)\s+short|more\s+terse|be\s+brief|brief\s+replies/.test(
      normalized,
    )
  ) {
    return finish({ brevity: "short" });
  }

  if (/more\s+detail|go\s+into\s+more\s+detail|explain\s+more|longer\s+repl(?:y|ies)|be\s+more\s+detailed/.test(normalized)) {
    return finish({ brevity: "detailed" });
  }

  if (/^(?:please\s+)?(?:no\s+emoji|stop\s+using\s+emoji|emoji\s+off)$/.test(normalized)) {
    return finish({ emoji: false });
  }

  if (/^(?:please\s+)?(?:use\s+emoji|emoji\s+on|add\s+emoji|more\s+emoji)$/.test(normalized)) {
    return finish({ emoji: true });
  }

  return null;
}

/**
 * OWNER_STYLE rendered as a CONTEXT block. Every value is stated explicitly so the model
 * has nothing to infer.
 */
export function renderOwnerStyleBlock(style: OwnerStyle): string {
  const terms = style.address_terms.length > 0 ? style.address_terms.join(", ") : "none";
  const tone = style.tone === "auto" ? "auto (mirror the owner)" : style.tone;
  const emoji = style.emoji ? "allowed after the owner uses one first" : "never";

  return [
    "OWNER_STYLE (address terms, tone, brevity, emoji):",
    `Address terms allowed: ${terms}`,
    `Tone: ${tone}`,
    `Brevity: ${style.brevity}`,
    `Emoji: ${emoji}`,
    style.address_terms.length === 0
      ? "The owner removed every address term: do not use any address term."
      : style.address_every_sentence
        ? "The owner requires an address term in EVERY sentence of every reply. Code enforces this; never drop it."
        : "Use an address term at most once per reply, and not in every reply.",
  ].join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
  return new RegExp(`\\b${escapeRegex(term)}\\b`, "gi");
}

export function countAddressTerms(reply: string, terms: string[]): number {
  if (!reply || !terms || terms.length === 0) return 0;
  let count = 0;
  for (const term of terms) {
    if (!term) continue;
    const matches = reply.match(termPattern(term));
    if (matches) count += matches.length;
  }
  return count;
}

function stripTerms(text: string, terms: string[]): string {
  let out = text;
  for (const term of terms) {
    if (!term) continue;
    out = out.replace(termPattern(term), "");
  }
  return out
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,;:])\s*\1+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+$/, "")
    .replace(/^[,\s]+/, "");
}

/** Keep only the first occurrence of any address term in the reply. */
function keepFirstTerm(text: string, terms: string[]): string {
  let firstIndex = -1;
  let firstLength = 0;
  for (const term of terms) {
    if (!term) continue;
    const match = new RegExp(`\\b${escapeRegex(term)}\\b`, "i").exec(text);
    if (match && (firstIndex === -1 || match.index < firstIndex)) {
      firstIndex = match.index;
      firstLength = match[0].length;
    }
  }
  if (firstIndex === -1) return text;

  const head = text.slice(0, firstIndex + firstLength);
  const tail = stripTerms(text.slice(firstIndex + firstLength), terms);
  return `${head}${tail}`
    .replace(/([,;:])\s*\./g, ".")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export interface GovernContext {
  tone: "casual" | "formal";
  previousReplyUsedTerm: boolean;
}

/**
 * Ensure the address-term rule holds: no term when the owner removed them, no term in a
 * casual reply that follows one, and never more than one term in a reply.
 */
export function governAddressTerms(
  reply: string,
  style: OwnerStyle,
  ctx: GovernContext,
): { text: string; decisions: string[] } {
  const decisions: string[] = [];
  const text = reply || "";
  const collapsed = text.replace(/\bsir\b[\s,;]+\bsir\b/gi, "sir");
  if (collapsed !== text) decisions.push("style_collapsed_duplicate_term");

  const allowed = style.address_terms.length > 0 ? style.address_terms : [];
  const known = allowed.length > 0 ? allowed : DEFAULT_OWNER_STYLE.address_terms;

  if (allowed.length === 0) {
    const stripped = stripTerms(collapsed, known);
    if (stripped !== collapsed) decisions.push("style_stripped_removed_term");
    return { text: stripped, decisions };
  }

  if (ctx.tone === "casual" && ctx.previousReplyUsedTerm) {
    const stripped = stripTerms(collapsed, known);
    if (stripped !== collapsed) decisions.push("style_skipped_repeated_term");
    return { text: stripped, decisions };
  }

  if (countAddressTerms(collapsed, known) > 1) {
    decisions.push("style_trimmed_extra_term");
    return { text: keepFirstTerm(collapsed, known), decisions };
  }

  return { text: collapsed, decisions };
}

/** Settings round-trip. */
export function serializeOwnerStyle(style: OwnerStyle): string {
  return JSON.stringify({
    address_terms: style.address_terms,
    tone: style.tone,
    brevity: style.brevity,
    emoji: style.emoji,
    address_every_sentence: style.address_every_sentence,
  });
}


/**
 * Recognises a standing address rule and pulls the term out of it. The owner writes these
 * as sentences ("always call me boss and say sir at the end"), so the term is the word
 * after "call me" or after "say", never a guess from the whole message.
 */
function matchAddressRule(normalized: string): { term: string | null; secondary: string | null; everySentence: boolean } | null {
  const everySentence =
    /\b(?:in\s+every\s+sentence|every\s+sentence|in\s+every\s+reply|always\s+say|at\s+the\s+end)\b/.test(
      normalized,
    );
  const callMe = normalized.match(/\bcall\s+me\s+([a-z][a-z'\-]{0,20})/);
  const addressMe = normalized.match(/\baddress\s+me\s+(?:as\s+)?([a-z][a-z'\-]{0,20})/);
  // "say sir ..." - but not "say that", "say something", "say it".
  const sayMatch = normalized.match(/\b(?:say|use)\s+(sir|boss|master|madam|chief|dude|bro)\b/);
  const requiresRule =
    everySentence ||
    /\b(?:always|must|from\s+now\s+on|every\s+time)\b/.test(normalized) ||
    /\b(?:put\s+(?:that|this)\s+(?:as|in)\s+my\s+(?:command|memory))\b/.test(normalized);

  if (!requiresRule) return null;

  const callTerm = callMe?.[1] || addressMe?.[1] || null;
  const sayTerm = sayMatch?.[1] || null;
  // "call me boss and say sir" keeps both, with the spoken term first so it is the one
  // the every-sentence rail uses.
  const term = sayTerm || callTerm;
  const secondary = sayTerm && callTerm && sayTerm !== callTerm ? callTerm : null;
  if (!term && !everySentence) return null;
  return { term, secondary, everySentence };
}

/**
 * Code-side guarantee for the owner's address rule. When he asked for an address term in
 * every sentence, any sentence without one gets ", <term>" before its final punctuation.
 * This is a mechanical style rail, not conversation: the model still writes the words.
 */
export function enforceAddressTerms(text: string, style: OwnerStyle): string {
  const body = (text || "").trim();
  if (!body) return text;
  if (!style.address_every_sentence) return text;
  const terms = style.address_terms.filter(Boolean);
  if (terms.length === 0) return text;
  const term = terms[0];

  // Keep paragraphs and line breaks; only rewrite sentences that lack the term.
  return body
    .split(/(\n+)/)
    .map((chunk) => {
      if (!chunk.trim() || /^\n+$/.test(chunk)) return chunk;
      return chunk
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => {
          if (!sentence.trim()) return sentence;
          if (countAddressTerms(sentence, terms) > 0) return sentence;
          // Buttons, bullets and single words stay untouched.
          if (sentence.trim().length < 3) return sentence;
          const match = sentence.match(/^(.*?)([.!?]*)\s*$/s);
          if (!match) return sentence;
          const core = match[1].replace(/\s+$/, "");
          const punctuation = match[2] || ".";
          return `${core}, ${term}${punctuation}`;
        })
        .join(" ");
    })
    .join("");
}

