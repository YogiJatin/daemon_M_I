/**
 * worker/memoryActions.ts - Code-owned memory mutations.
 *
 * Invariants:
 * - Forget outranks remember (handled by intentPreRouter before this runs).
 * - Nothing is deleted unless D1 reports a committed change; the reply is
 *   generated from that count, never from model text.
 * - More than one match is never guessed: the owner is shown the matches.
 * - Deletes are soft (deleted_at) so /undo can restore within 24h.
 */

import { enqueueMemoryMirror } from "./desktopMirrorService";

const STOPWORDS = new Set([
  "the", "that", "this", "with", "from", "your", "memory", "memories", "forget", "delete",
  "remove", "about", "have", "has", "had", "was", "were", "are", "and", "but", "not", "you",
  "his", "her", "its", "our", "their", "them", "they", "what", "when", "where", "which",
  "who", "whom", "will", "would", "can", "could", "should", "into", "than", "then", "there",
  "here", "just", "also", "very", "really", "been", "being", "does", "did", "doing", "for",
  "too", "get", "got", "out", "all", "any", "one", "two", "fact", "note", "info",
  "information", "please", "stored", "remember", "remembered",
]);

export function tokenizeMemoryQuery(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[-']+|[-']+$/g, ""))
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    .slice(0, 8);
}

export interface MemoryMatch {
  id: string;
  canonical_text: string;
  sensitivity?: string | null;
  score: number;
}

function likeToken(token: string): string {
  return `%${token.replace(/[%_]/g, "")}%`;
}

/** Case-insensitive token search over live (not soft-deleted) memories. */
export async function findMemoryMatches(
  db: D1Database,
  query: string,
  limit: number = 20
): Promise<MemoryMatch[]> {
  const tokens = tokenizeMemoryQuery(query);
  if (tokens.length === 0) return [];

  const where = tokens.map(() => "lower(canonical_text) LIKE ?").join(" OR ");
  const rows = await db
    .prepare(
      `SELECT id, canonical_text, sensitivity
       FROM memory_objects
       WHERE deleted_at IS NULL AND (${where})
       LIMIT ?`
    )
    .bind(...tokens.map(likeToken), limit)
    .all<{ id: string; canonical_text: string; sensitivity: string | null }>()
    .catch(() => ({ results: [] }));

  const scored = (rows.results || []).map((row) => {
    const lower = row.canonical_text.toLowerCase();
    const score = tokens.reduce((count, token) => (lower.includes(token) ? count + 1 : count), 0);
    return {
      id: row.id,
      canonical_text: row.canonical_text,
      sensitivity: row.sensitivity,
      score,
    };
  });

  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.canonical_text.localeCompare(b.canonical_text));
}

/**
 * Finds a same-topic memory with different wording. Used to offer Replace
 * instead of silently storing a contradictory duplicate.
 */
export async function findContradictingMemory(
  db: D1Database,
  text: string,
  now: Date = new Date()
): Promise<{ id: string; canonical_text: string } | null> {
  const targetTokens = new Set(tokenizeMemoryQuery(text));
  if (targetTokens.size === 0) return null;

  const rows = await db
    .prepare(
      `SELECT id, canonical_text
       FROM memory_objects
       WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .bind(now.toISOString())
    .all<{ id: string; canonical_text: string }>()
    .catch(() => ({ results: [] }));

  const normalizedTarget = text.trim().toLowerCase().replace(/\s+/g, " ");
  let best: { id: string; canonical_text: string; score: number } | null = null;

  for (const row of rows.results || []) {
    const normalizedRow = row.canonical_text.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalizedRow === normalizedTarget) continue;
    const rowTokens = new Set(tokenizeMemoryQuery(row.canonical_text));
    if (rowTokens.size === 0) continue;
    let intersection = 0;
    for (const token of targetTokens) {
      if (rowTokens.has(token)) intersection++;
    }
    const score = intersection / Math.min(targetTokens.size, rowTokens.size);
    if (score >= 0.6 && (!best || score > best.score)) {
      best = { id: row.id, canonical_text: row.canonical_text, score };
    }
  }

  return best ? { id: best.id, canonical_text: best.canonical_text } : null;
}

export interface ForgetOutcome {
  status: "none" | "deleted" | "ambiguous" | "settings_deleted";
  reply: string;
  deletedIds: string[];
  matches: MemoryMatch[];
}

async function forgetFromSettings(
  db: D1Database,
  query: string,
  now: Date
): Promise<ForgetOutcome | null> {
  const tokens = tokenizeMemoryQuery(query);
  if (tokens.length === 0) return null;

  const row = await db
    .prepare("SELECT value FROM settings WHERE key = 'about_me_summary'")
    .first<{ value: string }>()
    .catch(() => null);
  if (!row?.value) return null;

  const sentences = row.value.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    return !tokens.some((token) => lower.includes(token));
  });
  if (kept.length === sentences.length) return null;

  const nowIso = now.toISOString();
  if (kept.join(" ").trim().length === 0) {
    await db.prepare("DELETE FROM settings WHERE key = 'about_me_summary'").run().catch(() => {});
  } else {
    await db
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'about_me_summary'")
      .bind(kept.join(" ").trim(), nowIso)
      .run()
      .catch(() => {});
  }

  return {
    status: "settings_deleted",
    reply: "Deleted 1 memory.",
    deletedIds: ["settings:about_me_summary"],
    matches: [],
  };
}

/** Deletes exactly one match, or asks which one when several match. */
export async function handleForgetMemory(
  db: D1Database,
  rawQuery: string,
  now: Date = new Date()
): Promise<ForgetOutcome> {
  const query = (rawQuery || "").trim();
  if (!query) {
    return { status: "none", reply: "No matching memory.", deletedIds: [], matches: [] };
  }

  const matches = await findMemoryMatches(db, query);

  if (matches.length > 1) {
    const listing = matches
      .slice(0, 5)
      .map((match) => `[${match.id}] "${match.canonical_text}"`)
      .join("\n");
    return {
      status: "ambiguous",
      reply: `${matches.length} matches:\n${listing}\nWhich one? Reply /forget <id>.`,
      deletedIds: [],
      matches,
    };
  }

  if (matches.length === 1) {
    const nowIso = now.toISOString();
    const result = await db
      .prepare(
        "UPDATE memory_objects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      )
      .bind(nowIso, nowIso, matches[0].id)
      .run()
      .catch(() => null);

    const changes = Number((result as any)?.meta?.changes ?? 0);
    if (changes === 0) {
      return { status: "none", reply: "No matching memory.", deletedIds: [], matches };
    }

    // Mirror delete only after the D1 delete committed.
    await enqueueMemoryMirror(
      db,
      {
        id: matches[0].id,
        type: "fact",
        title: "",
        canonical_text: matches[0].canonical_text,
        sensitivity: matches[0].sensitivity ?? "normal",
        created_at: nowIso,
      },
      "delete",
      now
    ).catch(() => {});

    return {
      status: "deleted",
      reply: `Deleted ${changes} ${changes === 1 ? "memory" : "memories"}.`,
      deletedIds: [matches[0].id],
      matches,
    };
  }

  const settingsOutcome = await forgetFromSettings(db, query, now);
  if (settingsOutcome) return settingsOutcome;

  return { status: "none", reply: "No matching memory.", deletedIds: [], matches: [] };
}

/** Restores the most recently soft-deleted memory within the window. */
export async function restoreLatestMemory(
  db: D1Database,
  sinceIso: string,
  now: Date = new Date()
): Promise<{ restoredId: string | null; reply: string }> {
  const row = await db
    .prepare(
      `SELECT id, type, title, canonical_text, summary, sensitivity, trust, created_at, updated_at
       FROM memory_objects
       WHERE deleted_at IS NOT NULL AND deleted_at >= ?
       ORDER BY deleted_at DESC
       LIMIT 1`
    )
    .bind(sinceIso)
    .first<{
      id: string;
      type: string;
      title: string;
      canonical_text: string;
      summary: string | null;
      sensitivity: string | null;
      trust: string | null;
      created_at: string;
      updated_at: string | null;
    }>()
    .catch(() => null);

  if (!row) {
    return { restoredId: null, reply: "No memory deletions found within the last 24h to undo." };
  }

  const result = await db
    .prepare("UPDATE memory_objects SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL")
    .bind(now.toISOString(), row.id)
    .run()
    .catch(() => null);

  const changes = Number((result as any)?.meta?.changes ?? 0);
  if (changes === 0) {
    return { restoredId: null, reply: "Nothing to restore." };
  }

  await enqueueMemoryMirror(db, row as any, "upsert", now).catch(() => {});

  return { restoredId: row.id, reply: `Restored 1 memory [${row.id}].` };
}
