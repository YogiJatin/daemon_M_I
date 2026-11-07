/**
 * worker/captureEngine.ts - Block 1 Implicit Capture Engine
 *
 * Detects first-person future obligations in English/Hinglish/Telugu-mixed text.
 * Manages /capture command, daily cap, cooldown, and capture_feedback table.
 *
 * Hard invariants:
 * - Implicit capture DISABLED when provider is workers_ai or mock.
 * - Daily cap: 3 suggestions (default), configurable.
 * - /capture off|low|normal|high - persisted in settings.
 * - [Not a task] button updates capture_feedback with phrase decay.
 * - Never surfaces suggestions for questions, hypotheticals, past events,
 *   jokes, other people's tasks, or already-captured items.
 */

// ---------------------------------------------------------------------------
// First-person obligation detection (heuristic, no LLM)
// ---------------------------------------------------------------------------

// Indicators of first-person future obligations and explicit task/reminder cues
const OBLIGATION_TRIGGERS = [
  /\bI need to\b/i,
  /\bI have to\b/i,
  /\bI should\b/i,
  /\bI must\b/i,
  /\bI will\b/i,
  /\bI am going to\b/i,
  /\bI'm going to\b/i,
  /\bI gotta\b/i,
  /\bgotta\b/i,
  /\bplanning to\b/i,
  /\bneed to\b/i,
  /\bhave to\b/i,
  /\bremember to\b/i,
  /\bremind me\b/i,
  /\bsubmit\b/i,
  // Hinglish patterns
  /\bjana hai\b/i,
  /\bkarni hai\b/i,
  /\bkarna hai\b/i,
  /\bhoga\b/i,
  /\bpadna hai\b/i,
  /\bdeni hai\b/i,
  /\bdena hai\b/i,
  /\bbhejo\b/i,
  /\bpadegi\b/i,
  /\bnikalna hai\b/i,
  /\bkarwana hai\b/i,
  /\ble lena\b/i,
  /\bprint karo\b/i,
  // Telugu patterns
  /\bcheyyali\b/i,
  /\bchestam\b/i,
  /\blevali\b/i,
  /\bvellali\b/i,
  /\bavali\b/i,
  /\bchaduvukovali\b/i,
  /\bteesukovali\b/i,
  /\bcheyinchukovali\b/i,
];

// Disqualifiers: questions, hypotheticals, past events, jokes, other people,
// bodily states, wishes/routines (Capture Rubric a-d)
const DISQUALIFIERS = [
  /\?$/,                        // ends in question mark
  /^(did|does|do|is|are|was|were|can|could|should|would|will|won't|isn't)\b/i,
  /^(have|has)\s+(you|we|they|he|she)\b/i,
  /\b(yesterday|last week|last month|ago|already|just did|finished|completed|done|kar diya|karega|karegi)\b/i,
  /\b(maybe|perhaps|might|could be|probably|if)\b/i,
  /\b(he|she|they|we|dost|friend)\s+(needs?|has|have|should|must|will|submit|karega)\b/i,  // other people
  /\b(just kidding|lol|lmao|haha|joke)\b/i,
  /\bhypothetically\b/i,
  // Wishes or vague routines - not concrete commitments (c)
  /\b(wish|want to visit|someday|one day|usually|typically|everyday)\b/i,
];

export function detectObligation(text: string): { detected: boolean; evidence: string } {
  const trimmed = text.trim();

  // Bodily states (not a commitment) unless it refers to a concrete work item like "the rest of" (A3, F02, F03)
  if (/\b(sleep early|so tired|take a nap|exhausted|headache|feeling sleepy|rest my eyes|need some sleep)\b/i.test(trimmed)) {
    return { detected: false, evidence: "" };
  }
  if (/\b(need to rest|need some rest|feel sick)\b/i.test(trimmed) && !/\brest of\b/i.test(trimmed)) {
    return { detected: false, evidence: "" };
  }

  // Check disqualifiers first
  for (const pattern of DISQUALIFIERS) {
    if (pattern.test(trimmed)) {
      return { detected: false, evidence: "" };
    }
  }

  // Check obligation triggers
  for (const pattern of OBLIGATION_TRIGGERS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { detected: true, evidence: match[0] };
    }
  }

  return { detected: false, evidence: "" };
}

// ---------------------------------------------------------------------------
// Normalize phrase for feedback tracking
// ---------------------------------------------------------------------------
export function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
}

// ---------------------------------------------------------------------------
// Check capture settings and daily cap
// ---------------------------------------------------------------------------
export async function getCaptureSettings(
  db: D1Database,
  env: any
): Promise<{ mode: string; dailyCap: number }> {
  const defaultMode = env?.CAPTURE_MODE || "normal";
  const defaultCap = parseInt(env?.CAPTURE_DAILY_CAP || "3", 10);

  try {
    const modeRow = await db
      .prepare("SELECT value FROM settings WHERE key = 'capture_mode'")
      .first<{ value: string }>();
    const capRow = await db
      .prepare("SELECT value FROM settings WHERE key = 'capture_daily_cap'")
      .first<{ value: string }>();
    return {
      mode: modeRow?.value || defaultMode,
      dailyCap: capRow ? parseInt(capRow.value, 10) : defaultCap,
    };
  } catch {
    return { mode: defaultMode, dailyCap: defaultCap };
  }
}

export async function getDailyImplicitCount(db: D1Database, now: Date): Promise<number> {
  try {
    const today = now.toISOString().slice(0, 10);
    const row = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM chat_messages
         WHERE intent = 'implicit_commitment' AND role = 'user'
           AND created_at >= ?`
      )
      .bind(today + "T00:00:00.000Z")
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Check phrase not in rejection feedback (with decay)
// ---------------------------------------------------------------------------
export async function isPhraseRejected(db: D1Database, phrase: string): Promise<boolean> {
  const normalized = normalizePhrase(phrase);
  if (!normalized) return false;

  try {
    const row = await db
      .prepare(
        `SELECT rejection_count, decay_factor FROM capture_feedback
         WHERE normalized_phrase = ?`
      )
      .bind(normalized)
      .first<{ rejection_count: number; decay_factor: number }>();

    if (!row) return false;
    // Reject if effective score >= 2 (count * decay)
    return row.rejection_count * row.decay_factor >= 2;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Record "Not a task" feedback
// ---------------------------------------------------------------------------
export async function recordRejectionFeedback(db: D1Database, phrase: string, now: Date): Promise<void> {
  const normalized = normalizePhrase(phrase);
  if (!normalized) return;
  const nowStr = now.toISOString();

  try {
    const existing = await db
      .prepare("SELECT id, rejection_count FROM capture_feedback WHERE normalized_phrase = ?")
      .bind(normalized)
      .first<{ id: string; rejection_count: number }>();

    if (existing) {
      await db
        .prepare(
          `UPDATE capture_feedback
           SET rejection_count = rejection_count + 1, last_rejected_at = ?
           WHERE normalized_phrase = ?`
        )
        .bind(nowStr, normalized)
        .run();
    } else {
      const id = "cap_" + Math.random().toString(36).slice(2, 10).toUpperCase();
      await db
        .prepare(
          `INSERT INTO capture_feedback (id, normalized_phrase, rejection_count, last_rejected_at, decay_factor, created_at)
           VALUES (?, ?, 1, ?, 1.0, ?)`
        )
        .bind(id, normalized, nowStr, nowStr)
        .run();
    }
  } catch (e) {
    console.warn("[CaptureEngine] Failed to record rejection:", e);
  }
}

// ---------------------------------------------------------------------------
// Handle /capture command
// ---------------------------------------------------------------------------
export async function handleCaptureCommand(
  args: string,
  db: D1Database,
  now: Date
): Promise<string> {
  const mode = args.trim().toLowerCase();
  const validModes = ["off", "low", "normal", "high"];

  if (!mode || !validModes.includes(mode)) {
    const current = await db
      .prepare("SELECT value FROM settings WHERE key = 'capture_mode'")
      .first<{ value: string }>()
      .catch(() => null);
    return `Implicit capture mode: ${current?.value || "normal"}\nOptions: /capture off | low | normal | high`;
  }

  const nowStr = now.toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('capture_mode', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
      )
      .bind(mode, nowStr, mode, nowStr)
      .run();
    return `Implicit capture set to: ${mode}`;
  } catch {
    return "Couldn't update capture mode right now.";
  }
}

// ---------------------------------------------------------------------------
// Should we surface implicit capture for this message?
// Returns false if mode=off, daily cap reached, or provider=workers_ai/mock
// ---------------------------------------------------------------------------
export async function shouldCaptureImplicit(
  db: D1Database,
  env: any,
  now: Date,
  providerUsed: string
): Promise<boolean> {
  // Disabled for degraded providers
  if (providerUsed.includes("workers_ai") || providerUsed.includes("mock")) {
    return false;
  }

  const { mode, dailyCap } = await getCaptureSettings(db, env);
  if (mode === "off") return false;

  const dailyCount = await getDailyImplicitCount(db, now);
  return dailyCount < dailyCap;
}
