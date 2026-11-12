/**
 * worker/identity.ts - the short answer to "who am i" / "what do you know about me".
 *
 * The owner asked for his profile, not the memory table: name first, then what is known
 * about his work and interests, and a question when something is still missing. Facts come
 * from D1 only; nothing here is invented.
 */

const IDENTITY_META = /address\s+term|assistant name|prefers to be addressed|pronoun/i;
const IDENTITY_NAME = /\bowner is\s+([^.]{3,120})/i;
const MY_NAME_IS = /\bmy name is\s+([^.]{3,120})/i;
const IDENTITY_DETAIL =
  /\b(work\w*|stud\w*|college|engineer\w*|job|interest\w*|likes?|love\w*|hobb\w*|dislike\w*|hate\w*|prefer\w*|favourite|favorite|goal\w*|project\w*)\b/i;

/** Pure formatter so the shape can be tested without a database. */
export function formatIdentityAnswer(facts: string[]): string {
  const clean = facts.map((fact) => (fact || "").trim()).filter(Boolean);
  const nameFact =
    clean.find((fact) => IDENTITY_NAME.test(fact)) || clean.find((fact) => MY_NAME_IS.test(fact));
  const nameMatch = nameFact ? IDENTITY_NAME.exec(nameFact) || MY_NAME_IS.exec(nameFact) : null;
  const name = nameMatch ? nameMatch[1].trim().replace(/[,;\s]+$/, "") : "";

  const details = clean.filter(
    (fact) => fact !== nameFact && !IDENTITY_META.test(fact) && IDENTITY_DETAIL.test(fact)
  );

  const lines: string[] = [];
  if (name) lines.push(`You are ${name}.`);
  if (details.length > 0) {
    lines.push("What I know:");
    for (const fact of details.slice(0, 4)) lines.push(`• ${fact}`);
  }
  if (!name || details.length < 2) {
    lines.push("Tell me what you do, what you like and what you dislike, and I will remember it.");
  }
  return lines.join("\n");
}

export async function renderIdentityAnswer(db: D1Database): Promise<string> {
  const nowIso = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT canonical_text FROM memory_objects
       WHERE deleted_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
         AND sensitivity != 'private'
       ORDER BY updated_at DESC LIMIT 40`
    )
    .bind(nowIso)
    .all<{ canonical_text: string }>()
    .catch(() => ({ results: [] as Array<{ canonical_text: string }> }));

  const facts = (rows.results || []).map((row) => row.canonical_text);
  return formatIdentityAnswer(facts);
}
