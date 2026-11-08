/**
 * tests/unit_memory_actions.ts - Stage 2 memory intent tests
 *
 * Covers the owner's exact failing messages:
 * 1. "Delete in your memory that I am a third-year ECE student" must not claim
 *    a removal unless D1 actually changed.
 * 2. Forget/delete outranks remember.
 * 3. One match soft-deletes; several matches are listed instead of guessed.
 * 4. "remember" proposals reject forget/delete/remove text.
 * 5. Contradictory memories offer Replace, and Replace soft-deletes the old row.
 * 6. /undo restores a soft-deleted memory.
 */

import assert from "node:assert";
import { createMockD1 } from "./mockD1";
import { handleForgetMemory, restoreLatestMemory, findMemoryMatches } from "../worker/memoryActions";
import { preRouteIntent, extractForgetQuery } from "../worker/intentPreRouter";
import {
  createMemoryProposal,
  handleSaveMemoryProposalCallback,
  retrieveMemoriesForPrompt,
} from "../worker/memoryService";

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  FAIL: ${name}\n     ${err.message}`);
  }
}

const NOW = new Date("2026-11-08T10:00:00.000Z");

async function seedMemory(db: any, id: string, text: string, createdAt = NOW.toISOString()) {
  await db
    .prepare(
      `INSERT INTO memory_objects (id, type, title, canonical_text, source, trust, sensitivity, created_at, updated_at)
       VALUES (?, 'fact', ?, ?, 'telegram_manual', 'high', 'normal', ?, ?)`
    )
    .bind(id, text.slice(0, 50), text, createdAt, createdAt)
    .run();
}

async function main() {
  console.log("\n=== Memory actions ===");

  await it("extracts the fact from 'Delete in your memory that ...'", () => {
    assert.strictEqual(
      extractForgetQuery("Delete in your memory that I am a third-year ECE student"),
      "I am a third-year ECE student"
    );
  });

  await it("routes forget before remember in the same message", () => {
    const routed = preRouteIntent(
      "Forget that I am a third-year ECE student and remember I prefer morning labs"
    );
    assert.strictEqual(routed?.kind, "forget_memory");
    assert.strictEqual(routed?.outranksRemember, true);
  });

  await it("does not pre-route 'remember to <task>' as a memory write", () => {
    assert.strictEqual(preRouteIntent("remember to buy milk"), null);
  });

  await it("replies 'No matching memory.' when nothing matches, without claiming a deletion", async () => {
    const db = createMockD1();
    const outcome = await handleForgetMemory(db, "I am a third-year ECE student", NOW);
    assert.strictEqual(outcome.status, "none");
    assert.strictEqual(outcome.reply, "No matching memory.");
    assert.doesNotMatch(outcome.reply, /deleted|removed/i);

    const rows = await db.prepare("SELECT COUNT(*) AS cnt FROM memory_objects").first<any>();
    assert.strictEqual(Number(rows.cnt), 0);
  });

  await it("soft-deletes exactly one match and replies from the D1 changes count", async () => {
    const db = createMockD1();
    await seedMemory(db, "mem_ece_1", "I am a third-year ECE student");

    const outcome = await handleForgetMemory(db, "third-year ECE student", NOW);
    assert.strictEqual(outcome.status, "deleted");
    assert.strictEqual(outcome.reply, "Deleted 1 memory.");
    assert.deepStrictEqual(outcome.deletedIds, ["mem_ece_1"]);

    const row = await db
      .prepare("SELECT deleted_at FROM memory_objects WHERE id = 'mem_ece_1'")
      .first<any>();
    assert.ok(row.deleted_at, "expected deleted_at to be set");

    const remaining = await findMemoryMatches(db, "third-year ECE student");
    assert.strictEqual(remaining.length, 0);

    const prompt = await retrieveMemoriesForPrompt(db, "ECE", NOW);
    assert.strictEqual(prompt.injectedIds.length, 0);
  });

  await it("lists matches instead of guessing when more than one memory matches", async () => {
    const db = createMockD1();
    await seedMemory(db, "mem_ece_1", "I am a third-year ECE student");
    await seedMemory(db, "mem_ece_2", "My ECE branch has 60 students");

    const outcome = await handleForgetMemory(db, "ECE", NOW);
    assert.strictEqual(outcome.status, "ambiguous");
    assert.strictEqual(outcome.deletedIds.length, 0);
    assert.match(outcome.reply, /mem_ece_1/);
    assert.match(outcome.reply, /mem_ece_2/);
    assert.match(outcome.reply, /Which one\?/);
    assert.doesNotMatch(outcome.reply, /^Deleted/i);

    const live = await db
      .prepare("SELECT COUNT(*) AS cnt FROM memory_objects WHERE deleted_at IS NULL")
      .first<any>();
    assert.strictEqual(Number(live.cnt), 2);
  });

  await it("removes the matching sentence from about_me_summary when no memory row matches", async () => {
    const db = createMockD1();
    await db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('about_me_summary', ?, ?)")
      .bind("Name: Doodam Yogi Jatin Sai. Third-year ECE student. Prefers evening study.", NOW.toISOString())
      .run();

    const outcome = await handleForgetMemory(db, "third-year ECE student", NOW);
    assert.strictEqual(outcome.status, "settings_deleted");
    assert.strictEqual(outcome.reply, "Deleted 1 memory.");

    const row = await db
      .prepare("SELECT value FROM settings WHERE key = 'about_me_summary'")
      .first<any>();
    assert.doesNotMatch(row.value, /ECE/);
    assert.match(row.value, /Doodam Yogi Jatin Sai/);
  });

  await it("rejects forget/delete/remove text as a remember proposal", async () => {
    const db = createMockD1();
    const proposal = await createMemoryProposal(db, "delete this memory", NOW);
    assert.strictEqual(proposal, null);

    const count = await db.prepare("SELECT COUNT(*) AS cnt FROM memory_proposals").first<any>();
    assert.strictEqual(Number(count.cnt), 0);
  });

  await it("offers Replace when a new memory contradicts an existing one", async () => {
    const db = createMockD1();
    await seedMemory(db, "mem_night", "I prefer studying at night");

    const proposal = await createMemoryProposal(db, "I prefer studying in the morning", NOW);
    assert.ok(proposal, "expected a replace proposal");
    assert.match(proposal!.replyText, /Replace this memory\?/);
    assert.strictEqual((proposal!.replyMarkup as any).inline_keyboard[0][0].callback_data.startsWith("replace_memory:"), true);

    const stored = await db
      .prepare("SELECT replaces_id FROM memory_proposals WHERE id = ?")
      .bind(proposal!.proposalId)
      .first<any>();
    assert.strictEqual(stored.replaces_id, "mem_night");
  });

  await it("Replace soft-deletes the old memory and saves the new one", async () => {
    const db = createMockD1();
    await seedMemory(db, "mem_night", "I prefer studying at night");
    const proposal = await createMemoryProposal(db, "I prefer studying in the morning", NOW);
    assert.ok(proposal);

    const message = await handleSaveMemoryProposalCallback(db, proposal!.proposalId, NOW);
    assert.match(message, /Saved memory/);

    const oldRow = await db
      .prepare("SELECT deleted_at FROM memory_objects WHERE id = 'mem_night'")
      .first<any>();
    assert.ok(oldRow.deleted_at, "old memory should be soft-deleted");

    const live = await db
      .prepare("SELECT canonical_text FROM memory_objects WHERE deleted_at IS NULL")
      .all<any>();
    assert.strictEqual(live.results.length, 1);
    assert.match(live.results[0].canonical_text, /morning/);
  });

  await it("/undo restores the most recent soft-deleted memory", async () => {
    const db = createMockD1();
    await seedMemory(db, "mem_ece_1", "I am a third-year ECE student");
    const outcome = await handleForgetMemory(db, "third-year ECE student", NOW);
    assert.strictEqual(outcome.status, "deleted");

    const restore = await restoreLatestMemory(
      db,
      new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString(),
      new Date(NOW.getTime() + 60_000)
    );
    assert.strictEqual(restore.restoredId, "mem_ece_1");
    assert.match(restore.reply, /Restored 1 memory/);

    const row = await db
      .prepare("SELECT deleted_at FROM memory_objects WHERE id = 'mem_ece_1'")
      .first<any>();
    assert.strictEqual(row.deleted_at, null);
  });

  console.log(`\nTOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
