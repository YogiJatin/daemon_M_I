# IMPLEMENTATION PROMPT — DAEMON MEMORY MERGE (paste into the coding agent)

> Paste this whole file into Antigravity (or Freebuff) together with
> `DAEMON_Master_Context_Merge_Report_2026-11-13.md`.
> It replaces the two earlier prompt drafts, because those assumed things about this
> repo that are not true (wrong path, and an Obsidian vault that does not exist yet).

---

## 0. Identities

- **DAEMON / `Daemon_M1_bot`** — Jatin's personal assistant, the system whose memory is being updated.
- **You** — the coding agent doing the work. You are not DAEMON.
- **Freebuff / Antigravity** — build tools, not part of the product.

You are updating DAEMON's knowledge stores and proving what changed. You are not rebuilding DAEMON.

## 1. Verified ground truth (do not re-derive, but confirm before writing)

| Item | Value |
|---|---|
| Repo | `C:\dev\personal-ai-os` (the `OneDrive\Desktop\Daemon_os` path in the old prompt is stale) |
| Branch / commit at hand-off | `main` @ `b6bf5f4` |
| Worker | `personal-ai-os`, `https://personal-ai-os.jatin-personal-ai.workers.dev` |
| D1 database | `personal-ai-os-db` (`3f9305ea-cc7b-47bc-ac11-07faff106096`) |
| Memory tables | `memory_objects`, `memory_tags`, `memory_relationships`, `memory_proposals` |
| Retrieval path | `worker/memoryService.ts` → `retrieveMemoriesForPrompt(db, query, now, limit=5, maxChars=1200)` (keyword-scored, no FTS, no vectors) |
| Standing context limit | ≤ 600 chars per record rendered into a prompt; `about_me_summary` is a single settings row |
| Timetable tables | `timetable_semesters` / `timetable_subjects` / `timetable_slots` / `timetable_materials` |
| Backup | `npm run backup:d1` → `C:\Users\yogid\backups\d1-<ts>.sql` + credential scan |
| Checks | `npx tsc --noEmit`, `npm test` (auto-discovers `tests/unit_*.ts`), `npm run build`, `npm run integrity`, `npx tsx scripts/deploy_model_guard.ts` |
| Deploy | `npm run deploy` (integrity → model guard → build → `wrangler deploy`) |

**Obsidian is not implemented.** The SRS lists it as `DEFER-03`; there is no vault path, no sync code, no Markdown writer anywhere in the worker. Any prompt that says "inspect the existing vault and merge into it" is describing something that does not exist.

## 2. Inputs you must have before starting

1. `DAEMON_Master_Context_Merge_Report_2026-11-13.md` — the reconciled context. **If it is missing, stop and ask for it.** It defines the `R1`, `D1–D3`, `P1–P4` source labels; do not invent them.
2. Owner confirmation of the Obsidian decision in §3.

## 3. Gate 1 — Obsidian decision (ask once, then continue)

Ask exactly one question:

> **Obsidian is not built yet (`DEFER-03`). Do you want (A) memory-only merge into D1 now, or (B) memory merge plus a Block 7 export to a Markdown vault folder?**

- **A (default, no code change):** write only to `memory_objects` + `memory_tags`. No Markdown, no sync claims.
- **B:** still do A first, then implement `worker/knowledgeNotes.ts` that renders approved records to `<vault>/DAEMON/<category>/<slug>.md` with YAML front-matter (`id`, `source`, `status`, `as_of`, `tags`, `links`). One-way D1 → vault only. Never parse the vault back into D1 in this block. State plainly that sync is **one-way and untested in reverse**.

Do not start B without an explicit "B".

## 4. Hard rules (violating any of these fails the block)

1. **No tasks, reminders or deadlines.** The report mentions goals, GSoC dates, a 4 Dec 2026 Student Researcher deadline. None of these may become a `tasks` or `notification` row. Verify afterwards that `tasks` row count is unchanged.
2. **No integrations.** Do not touch Gmail, Calendar, Drive, Notion, Gemini, Claude, WhatsApp. Do not rotate secrets or change webhooks.
3. **Additive only.** `INSERT OR IGNORE` with stable ids. Never `DELETE`, `UPDATE` or truncate an existing memory row. Corrections that must change a live fact = insert a new record + link it to the old one with `memory_relationships.relationship_type = 'supersedes'`.
4. **No secrets, no private message bodies, no tokens** in any record, tag, note or commit.
5. **No invented facts.** Anything the report leaves open goes in as `status: unresolved`, not a guess.
6. **Do not reformat unrelated code.** This is a data/content block.

## 5. Phase 1 — read-only inspection

Run and record output for:

```bash
git -C C:/dev/personal-ai-os status --short
git -C C:/dev/personal-ai-os log -1 --oneline
npx wrangler d1 execute personal-ai-os-db --remote --command "SELECT COUNT(*) FROM memory_objects WHERE deleted_at IS NULL;"
npx wrangler d1 execute personal-ai-os-db --remote --command "SELECT id, title, source, trust, sensitivity FROM memory_objects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 40;"
npx wrangler d1 execute personal-ai-os-db --remote --command "SELECT COUNT(*) FROM tasks;"
```

Also read: `worker/memoryService.ts` (`retrieveMemoriesForPrompt`, `createMemoryProposal`, `handleMemoriesCommand`), `worker/identity.ts` (`formatIdentityAnswer`), `Personal_AI_OS_SRS_v2.2.md` §memory/`DEFER-03`, and `AGENTS.md`.

Produce a capability matrix — **Verified / Partially verified / Not implemented / Not connected / Blocked / Unknown** — with evidence for: memory capture, memory retrieval, memory correction, memory deletion, memory proposal cards, task creation, reminder scheduling, Obsidian, vector index, backups, tests. Current known state to verify, not assume:

- Memory capture: verified (Telegram command + proposal card).
- Retrieval: verified — but **keyword-scored, top 5, 1200 chars**, so records must be small and well-titled.
- Obsidian: not implemented.
- Vector index: not implemented.
- Backups: verified (`npm run backup:d1`).

## 6. Phase 2 — record design (still read-only)

### 6.1 Target shape

One row per fact in `memory_objects`:

| column | rule |
|---|---|
| `id` | `mem_ctx_<category>_<slug>_<yyyymmdd>` — stable, lowercase, no spaces |
| `type` | `fact` \| `project` \| `decision` \| `preference` \| `history` |
| `title` | ≤ 80 chars, self-describing (this is what retrieval matches) |
| `canonical_text` | ≤ 600 chars, one fact, third person ("Owner is…", "VeilAi is…") |
| `source` | `merge_report_2026_11_13` (never `telegram_ai_suggested`) |
| `metadata_json` | `{"report_section":"…","source_label":"R1|D1|D2|D3|P1..P4","status":"current|historical|proposed|unresolved","as_of":"YYYY-MM-DD","links":["mem_ctx_…"]}` |
| `trust` | `high` for explicit owner answers, `medium` for report inferences |
| `sensitivity` | `normal` unless personal/health/financial → `private` (private rows are excluded from prompts) |
| `tags` | short taxonomy, see below |

Tags (use these, do not invent new ones without listing them in the proposal):
`profile`, `academic`, `timetable`, `hardware`, `daemon`, `daemon-history`, `project`, `career`, `gsoc`, `internship`, `learning`, `dsa`, `college-role`, `tasks-rules`, `memory-governance`, `integration`, `decision`, `unresolved`.

### 6.2 Knowledge areas (all 12, one or more records each)

1. Profile, education, schedule, hardware, working preferences.
2. DAEMON identity and behaviour.
3. DAEMON predecessor history (Hot/Warm/Cold, Saptashva, Aruna, Cloak, General Agent, Daily Briefing, old visual identity) — `type=history`, `status=historical` unless code proves otherwise.
4. Current `Daemon_M1_bot` implementation, verified only.
5. Project register — **separate** records: Video Analytics, VeilAi, AstraTrace, AYUSH AI, DISSECT, Math Document Generator, discontinued DAEMON-Suite, inactive ideas.
6. Career — GSoC (keep **both** rankings with dates), Google Student Researcher, internships, roadmap, DSA, portfolio.
7. College roles and completed activities.
8. Task/reminder/quiet-hour/planning rules.
9. Memory governance.
10. Integration states and deferments.
11. Coding-agent workflow preferences.
12. Historical decisions and unresolved items.

### 6.3 Conflict handling

- Changed facts: new row + `supersedes` link to the old row. Never edit the old row.
- VeilAi ≠ AstraTrace ≠ AYUSH AI — separate ids, no merge.
- AstraTrace ↔ AegisEO relationship unknown → `status: unresolved`.
- `Daemon_M1_bot` ≠ DAEMON-Suite/VitaSuite.
- Math doc generator → `status: unresolved` (not active, not abandoned).
- Motorcycle / skincare → research only, mark `status: historical`, do not imply purchases.
- GSoC / internship / building are all important — no single "chosen path" record.

## 7. Phase 3 — proposal, then STOP

Present, in one message:

1. Repo path, branch, commit, working-tree state.
2. Stores found (and the missing Obsidian).
3. Capability matrix.
4. Backup readiness (`npm run backup:d1` output path + size + credential scan).
5. The **record table**: id, title, type, tags, status — the full list, before writing.
6. The `supersedes` / `links` edge list.
7. Counts: add / link / leave untouched.
8. Risks and the exact commands you will run.

Then ask one question: **"Approve this merge?"** Do not write until the owner answers yes.

## 8. Phase 4 — apply (after approval)

1. `npm run backup:d1`, record path + bytes + "credential scan clean".
2. Write `migrations/merge_context_2026_11_13.sql` containing only `INSERT OR IGNORE` for `memory_objects`, `memory_tags`, `memory_relationships`.
3. Add a manifest table row per record so the merge is auditable and re-runnable:

```sql
CREATE TABLE IF NOT EXISTS memory_merge_manifest (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL, operation TEXT NOT NULL,
  source TEXT NOT NULL, applied_at TEXT NOT NULL, note TEXT
);
```

4. Apply to **local first** (`wrangler d1 execute --local`), run the retrieval checks, then `--remote`.
5. Do not touch `about_me_summary` unless the owner approves a specific replacement string.

## 9. Phase 5 — verify (mandatory, with output pasted in the report)

Retrieval checks through the real path, not `SELECT *`:

```bash
npx tsx tests/manual_memory_retrieval.ts "who am i" "what is my timetable" "what is VeilAi" \
  "what is DISSECT" "is DAEMON-Suite active" "what are my GSoC goals" "do you know my laptop"
```

(`tests/manual_memory_retrieval.ts` calls `retrieveMemoriesForPrompt` and prints the `<DATA>` block plus injected ids. Create it if absent; it is a manual script, not a suite.)

Also verify:

- `SELECT COUNT(*) FROM tasks;` unchanged from Phase 1.
- `SELECT COUNT(*) FROM memory_objects WHERE source='merge_report_2026_11_13';` equals the approved count.
- No record contains `token`, `key`, `password`, `Bearer`, or a phone number.
- Every `current` record has `as_of`; every `supersedes` edge points at an existing id.
- Two records do not contradict each other on the same subject (check GSoC ranking and project status explicitly).
- `npx tsc --noEmit` and `npm test` still pass if any code (script, table, retrieval test) changed.

If B was chosen: open two sample files, confirm front-matter, confirm links resolve inside the vault, and state that only one-way sync was tested.

## 10. Final report (exact sections)

Repo/commit · stores written · backup path + verification · counts (added/linked/unchanged) · provenance scheme · retrieval results verbatim · Obsidian result or "not implemented" · tests run + results · unresolved conflicts · failed/partial writes · confirmation that no tasks, reminders, messages or calendar entries were created · block gate **PASS / FAIL / PARTIAL**.

Never write "everything is synced". Never report a capability as implemented because the report says so.

## 11. What is explicitly out of scope for this block

- Creating tasks from career goals or deadlines.
- Enabling any integration.
- Editing `worker/prompts.ts` persona text, model order, or provider config.
- Deleting or merging existing memories.
- Building a vector index or embedding store.
- Bidirectional Obsidian sync.
