/**
 * worker/memoryService.ts - Block 2 Memory OS Implementation
 *
 * Core invariant:
 * - Code-only writes for /remember, /forget, /memories, /about.
 * - AI suggestions go via memory_proposals with [Save][Edit][Cancel]; nothing stored until tap.
 * - Secrets guard covers all memory write paths.
 * - Private memories never appear in prompts.
 * - Deduplicated and bounded retrieval (<=5 objects, <=1200 chars).
 * - Facts about user schedule/tasks come only from timetable/D1, never memory.
 */

import { checkAndRedactSecrets } from "./secretsGuard";
import { findContradictingMemory } from "./memoryActions";
import { isMemoryMutation } from "./intentSchema";
import { enqueueMemoryMirror } from "./desktopMirrorService";

export interface MemoryObject {
  id: string;
  type: string;
  title: string;
  canonical_text: string;
  source: "telegram_manual" | "telegram_ai_suggested";
  trust: "high" | "medium";
  sensitivity: "normal" | "private";
  tags?: string;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
  expires_at?: string;
}

function ulid(): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  const rand = Math.random().toString(36).slice(2, 10).padStart(8, "0");
  return (ts + rand).toUpperCase();
}

function makeInlineKeyboard(buttons: Array<{ text: string; callback_data: string }>) {
  return { inline_keyboard: [buttons] };
}

// ---------------------------------------------------------------------------
// 1.2 /remember <text> & /remember private <text>
// ---------------------------------------------------------------------------
export async function handleRememberCommand(
  args: string,
  db: D1Database,
  now: Date = new Date()
): Promise<{ success: boolean; response: string }> {
  const rawText = args.trim();
  if (!rawText) {
    return {
      success: false,
      response: "Usage: /remember <fact or preference>  or  /remember private <sensitive fact>",
    };
  }

  // Secrets Guard
  const secretCheck = checkAndRedactSecrets(rawText);
  if (secretCheck.isSecret) {
    return {
      success: false,
      response: "I don't store secrets.",
    };
  }

  let sensitivity: "normal" | "private" = "normal";
  let memText = rawText;
  if (rawText.toLowerCase().startsWith("private ")) {
    sensitivity = "private";
    memText = rawText.slice(8).trim();
  }

  if (!memText) {
    return { success: false, response: "Cannot remember empty text." };
  }

  const nowIso = now.toISOString();

  // Normalized dedupe
  const existing = await db
    .prepare(
      `SELECT id FROM memory_objects
       WHERE deleted_at IS NULL
         AND lower(trim(canonical_text)) = lower(trim(?))
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    )
    .bind(memText, nowIso)
    .first<{ id: string }>()
    .catch(() => null);

  if (existing) {
    return {
      success: true,
      response: `Already remembered [${existing.id}]: "${memText}"`,
    };
  }

  const id = "mem_" + ulid();
  const title = memText.slice(0, 50);

  await db
    .prepare(
      `INSERT INTO memory_objects
         (id, type, title, canonical_text, source, trust, sensitivity, created_at, updated_at)
       VALUES (?, 'fact', ?, ?, 'telegram_manual', 'high', ?, ?, ?)`
    )
    .bind(id, title, memText, sensitivity, nowIso, nowIso)
    .run();

  return {
    success: true,
    response: `Saved memory [${id}]: "${memText}"`,
  };
}

// ---------------------------------------------------------------------------
// 1.3 /memories (paged list from D1, identical with AI down)
// ---------------------------------------------------------------------------
export async function handleMemoriesCommand(
  db: D1Database,
  now: Date = new Date()
): Promise<{ success: boolean; response: string }> {
  const nowIso = now.toISOString();

  const rows = await db
    .prepare(
      `SELECT id, source, trust, sensitivity, canonical_text, created_at
       FROM memory_objects
       WHERE deleted_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC
       LIMIT 15`
    )
    .bind(nowIso)
    .all<{
      id: string;
      source: string;
      trust: string;
      sensitivity: string;
      canonical_text: string;
      created_at: string;
    }>()
    .catch(() => ({ results: [] }));

  if (!rows.results || rows.results.length === 0) {
    return {
      success: true,
      response: "No memories saved yet. Use /remember <text> to store facts or preferences.",
    };
  }

  // The owner asked for what is remembered, not how it is stored: no ids, sources,
  // trust labels or dates in the default listing.
  const lines = ["Here is what I remember:"];
  for (const m of rows.results) {
    const privTag = m.sensitivity === "private" ? " (private)" : "";
    lines.push(`• ${m.canonical_text}${privTag}`);
  }

  return {
    success: true,
    response: lines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// 1.3 /forget <id>
// ---------------------------------------------------------------------------
export async function handleForgetCommand(
  args: string,
  db: D1Database
): Promise<{ success: boolean; response: string; replyMarkup?: any }> {
  const targetId = args.trim();
  if (!targetId) {
    return {
      success: false,
      response: "Usage: /forget <memory_id>",
    };
  }

  const existing = await db
    .prepare("SELECT id, canonical_text FROM memory_objects WHERE id = ? AND deleted_at IS NULL")
    .bind(targetId)
    .first<{ id: string; canonical_text: string }>()
    .catch(() => null);

  if (!existing) {
    return {
      success: true,
      response: `Memory [${targetId}] not found or already deleted.`,
    };
  }

  const markup = makeInlineKeyboard([
    { text: "Delete", callback_data: `delete_memory:${targetId}` },
    { text: "Cancel", callback_data: `cancel_forget:${targetId}` },
  ]);

  return {
    success: true,
    response: `Forget this memory?\n"${existing.canonical_text}"`,
    replyMarkup: markup,
  };
}

// ---------------------------------------------------------------------------
// Idempotent Delete Memory Callback
// ---------------------------------------------------------------------------
export async function handleDeleteMemoryCallback(
  db: D1Database,
  memoryId: string,
  now: Date = new Date()
): Promise<string> {
  const nowIso = now.toISOString();
  const existing = await db
    .prepare(
      `SELECT id, type, title, canonical_text, summary, sensitivity, trust, created_at, updated_at
       FROM memory_objects WHERE id = ?`
    )
    .bind(memoryId)
    .first<any>()
    .catch(() => null);

  const res = await db
    .prepare("UPDATE memory_objects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(nowIso, nowIso, memoryId)
    .run()
    .catch(() => null);

  const changes = Number((res as any)?.meta?.changes ?? 0);
  if (changes === 0) {
    return `Memory [${memoryId}] already removed.`;
  }

  // Mirror delete fires only on a committed D1 delete.
  if (existing) {
    await enqueueMemoryMirror(db, existing as any, "delete", now).catch(() => {});
  }

  return "Deleted 1 memory.";
}

// ---------------------------------------------------------------------------
// 1.4 AI-Suggested Memory Proposal Creation (intent: "remember")
// ---------------------------------------------------------------------------
export async function createMemoryProposal(
  db: D1Database,
  text: string,
  now: Date = new Date()
): Promise<{ proposalId: string; replyText: string; replyMarkup: any } | null> {
  // Forget/delete/remove is a mutation intent, never a remember proposal.
  if (isMemoryMutation(text)) {
    return null;
  }

  const secretCheck = checkAndRedactSecrets(text);
  if (secretCheck.isSecret) {
    return null;
  }

  const trimmedText = text.trim();
  if (!trimmedText) return null;

  const nowIso = now.toISOString();

  // Exact duplicate: code-owned reply, no card.
  const existingMem = await db
    .prepare(
      `SELECT id, canonical_text FROM memory_objects
       WHERE deleted_at IS NULL
         AND lower(trim(canonical_text)) = lower(trim(?))
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    )
    .bind(trimmedText, nowIso)
    .first<{ id: string; canonical_text: string }>()
    .catch(() => null);

  if (existingMem) {
    return {
      proposalId: existingMem.id,
      replyText: `Already remembered [${existingMem.id}]: "${existingMem.canonical_text}"`,
      replyMarkup: undefined,
    };
  }

  // Contradiction: same topic, different wording -> offer Replace.
  const contradiction = await findContradictingMemory(db, trimmedText, now);
  if (contradiction) {
    const proposalId = "mprop_" + ulid();
    await db
      .prepare(
        `INSERT INTO memory_proposals
           (id, canonical_text, source, trust, sensitivity, status, replaces_id, created_at, updated_at)
         VALUES (?, ?, 'telegram_ai_suggested', 'medium', 'normal', 'pending', ?, ?, ?)`
      )
      .bind(proposalId, trimmedText, contradiction.id, nowIso, nowIso)
      .run()
      .catch(() => {});

    return {
      proposalId,
      replyText: `Replace this memory?\nOld: "${contradiction.canonical_text}"\nNew: "${trimmedText}"`,
      replyMarkup: makeInlineKeyboard([
        { text: "Replace", callback_data: `replace_memory:${proposalId}` },
        { text: "Cancel", callback_data: `reject_memory:${proposalId}` },
      ]),
    };
  }

  const existingProp = await db
    .prepare(
      `SELECT id FROM memory_proposals
       WHERE lower(trim(canonical_text)) = lower(trim(?))
         AND status = 'pending'
       LIMIT 1`
    )
    .bind(trimmedText)
    .first<{ id: string }>()
    .catch(() => null);

  const proposalId = existingProp?.id || "mprop_" + ulid();

  if (!existingProp) {
    await db
      .prepare(
        `INSERT INTO memory_proposals
           (id, canonical_text, source, trust, sensitivity, status, replaces_id, created_at, updated_at)
         VALUES (?, ?, 'telegram_ai_suggested', 'medium', 'normal', 'pending', NULL, ?, ?)`
      )
      .bind(proposalId, trimmedText, nowIso, nowIso)
      .run()
      .catch(() => {});
  }

  const replyText = `Remember this?\n"${trimmedText}"`;
  const replyMarkup = makeInlineKeyboard([
    { text: "Confirm", callback_data: `save_memory:${proposalId}` },
    { text: "Cancel", callback_data: `reject_memory:${proposalId}` },
  ]);

  return { proposalId, replyText, replyMarkup };
}

// ---------------------------------------------------------------------------
// Confirm / Save Memory Proposal Callback
// ---------------------------------------------------------------------------
export async function handleSaveMemoryProposalCallback(
  db: D1Database,
  proposalId: string,
  now: Date = new Date()
): Promise<string> {
  const prop = await db
    .prepare("SELECT * FROM memory_proposals WHERE id = ? AND status = 'pending'")
    .bind(proposalId)
    .first<any>()
    .catch(() => null);

  if (!prop) {
    return "Memory proposal already processed or expired.";
  }

  const nowIso = now.toISOString();
  const memId = "mem_" + ulid();

  // Replace flow: soft-delete the contradicted memory only after the owner taps.
  if (prop.replaces_id) {
    const replaced = await db
      .prepare("UPDATE memory_objects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(nowIso, nowIso, prop.replaces_id)
      .run()
      .catch(() => null);

    if (Number((replaced as any)?.meta?.changes ?? 0) > 0) {
      await enqueueMemoryMirror(
        db,
        {
          id: prop.replaces_id,
          type: "fact",
          title: "",
          canonical_text: "",
          sensitivity: "normal",
          created_at: nowIso,
        },
        "delete",
        now
      ).catch(() => {});
    }
  }

  await db
    .prepare(
      `INSERT INTO memory_objects
         (id, type, title, canonical_text, source, trust, sensitivity, created_at, updated_at)
       VALUES (?, 'fact', ?, ?, 'telegram_ai_suggested', 'medium', 'normal', ?, ?)`
    )
    .bind(memId, prop.canonical_text.slice(0, 50), prop.canonical_text, nowIso, nowIso)
    .run();

  await db
    .prepare("UPDATE memory_proposals SET status = 'accepted', updated_at = ? WHERE id = ?")
    .bind(nowIso, proposalId)
    .run();

  await enqueueMemoryMirror(
    db,
    {
      id: memId,
      type: "fact",
      title: prop.canonical_text.slice(0, 50),
      canonical_text: prop.canonical_text,
      sensitivity: "normal",
      trust: "medium",
      created_at: nowIso,
    },
    "upsert",
    now
  ).catch(() => {});

  return `Saved memory [${memId}]: "${prop.canonical_text}"`;
}

export async function handleReplaceMemoryProposalCallback(
  db: D1Database,
  proposalId: string,
  now: Date = new Date()
): Promise<string> {
  return handleSaveMemoryProposalCallback(db, proposalId, now);
}

// ---------------------------------------------------------------------------
// 1.5 Bounded Retrieval for Prompts (<=5 objects, <=1200 chars, no private)
// ---------------------------------------------------------------------------
export async function retrieveMemoriesForPrompt(
  db: D1Database,
  queryText: string = "",
  now: Date = new Date(),
  limit: number = 5,
  maxChars: number = 1200
): Promise<{ xmlBlock: string; injectedIds: string[] }> {
  const nowIso = now.toISOString();

  type MemoryRow = {
    id: string;
    canonical_text: string;
    source: string;
    trust: string;
    created_at: string;
  };

  const CANDIDATES = 25;
  const baseWhere =
    "deleted_at IS NULL AND sensitivity != 'private' AND (expires_at IS NULL OR expires_at > ?)";
  const queryWords = queryText
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  // Relevance first, recency second. Selecting only the newest 25 rows meant an older
  // memory that actually answered the question was never even considered.
  const memories: MemoryRow[] = [];
  const seen = new Set<string>();

  if (queryWords.length > 0) {
    const likeClauses = queryWords.map(() => "lower(canonical_text) LIKE ?").join(" OR ");
    const matched = await db
      .prepare(
        `SELECT id, canonical_text, source, trust, created_at
         FROM memory_objects
         WHERE ${baseWhere} AND (${likeClauses})
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(nowIso, ...queryWords.map((w) => `%${w}%`), CANDIDATES)
      .all<MemoryRow>()
      .catch(() => ({ results: [] as MemoryRow[] }));

    for (const row of matched.results || []) {
      memories.push(row);
      seen.add(row.id);
    }
  }

  if (memories.length < CANDIDATES) {
    const recent = await db
      .prepare(
        `SELECT id, canonical_text, source, trust, created_at
         FROM memory_objects
         WHERE ${baseWhere}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(nowIso, CANDIDATES)
      .all<MemoryRow>()
      .catch(() => ({ results: [] as MemoryRow[] }));

    for (const row of recent.results || []) {
      if (seen.has(row.id)) continue;
      memories.push(row);
      seen.add(row.id);
      if (memories.length >= CANDIDATES) break;
    }
  }

  if (memories.length === 0) {
    return { xmlBlock: "", injectedIds: [] };
  }
  const scored = memories.map((m) => {
    let matchCount = 0;
    const lower = m.canonical_text.toLowerCase();
    for (const w of queryWords) {
      if (lower.includes(w)) matchCount++;
    }
    return { m, matchCount };
  });

  scored.sort((a, b) => b.matchCount - a.matchCount);

  const selected: any[] = [];
  let totalChars = 0;

  for (const item of scored) {
    if (selected.length >= limit) break;
    const itemLen = item.m.canonical_text.length;
    if (totalChars + itemLen > maxChars) break;
    selected.push(item.m);
    totalChars += itemLen;
  }

  if (selected.length === 0) {
    return { xmlBlock: "", injectedIds: [] };
  }

  const injectedIds = selected.map((m) => m.id);

  // Update last_used_at for injected items
  for (const id of injectedIds) {
    await db
      .prepare("UPDATE memory_objects SET last_used_at = ? WHERE id = ?")
      .bind(nowIso, id)
      .run()
      .catch(() => {});
  }

  // Audit log injected memories
  try {
    const auditId = "aud_mem_" + ulid();
    await db
      .prepare(
        `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
         VALUES (?, 'memory', 'injection', 'prompt_injection', 'system', ?, ?)`
      )
      .bind(auditId, JSON.stringify({ injected_ids: injectedIds, query: queryText.slice(0, 100) }), nowIso)
      .run();
  } catch {}

  const lines = [`<DATA type="memory">`];
  for (const m of selected) {
    lines.push(`- [${m.id}] (${m.source}, ${m.trust} trust): ${m.canonical_text}`);
  }
  lines.push(`</DATA>`);

  return {
    xmlBlock: lines.join("\n"),
    injectedIds,
  };
}

// ---------------------------------------------------------------------------
// 1.9 /about flow (capped at 600 chars)
// ---------------------------------------------------------------------------
export async function handleAboutCommand(
  args: string,
  db: D1Database,
  now: Date = new Date()
): Promise<{ success: boolean; response: string }> {
  const rawText = args.trim();
  if (!rawText) {
    const current = await db
      .prepare("SELECT value FROM settings WHERE key = 'about_me_summary'")
      .first<{ value: string }>()
      .catch(() => null);

    if (current?.value) {
      return {
        success: true,
        response: `About You:\n"${current.value}"\n\nTo update, run: /about <brief summary>`,
      };
    }
    return {
      success: true,
      response: "No 'About You' standing context set yet. Set it with: /about <brief summary about you>",
    };
  }

  const secretCheck = checkAndRedactSecrets(rawText);
  if (secretCheck.isSecret) {
    return {
      success: false,
      response: "I don't store secrets.",
    };
  }

  const capped = rawText.slice(0, 600);
  const nowIso = now.toISOString();

  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('about_me_summary', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(capped, nowIso)
    .run();

  return {
    success: true,
    response: `Updated 'About You' standing context (${capped.length} chars).`,
  };
}

export async function getAboutMeStandingContext(db: D1Database): Promise<string> {
  const current = await db
    .prepare("SELECT value FROM settings WHERE key = 'about_me_summary'")
    .first<{ value: string }>()
    .catch(() => null);

  if (current?.value) {
    return `<DATA type="about_me">\n${current.value}\n</DATA>`;
  }
  return "";
}
