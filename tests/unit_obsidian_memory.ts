/**
 * tests/unit_obsidian_memory.ts
 *
 * Stage 3: one-way D1 -> Obsidian memory mirror.
 * Covers: note formatting, private exclusion, upsert jobs, delete only after a
 * committed D1 delete, reconcile pass (24h marker), and agent-side deletion.
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createMockD1 } from "./mockD1";
import { formatMemoryNote, isMirrorableMemory } from "../worker/obsidianMirror";
import {
  acknowledgeMirrorJob,
  claimPendingMirrorJobs,
  enqueueMemoryMirror,
  MIRROR_MAX_ATTEMPTS,
  reconcileMemoryMirror,
} from "../worker/desktopMirrorService";
import { handleDeleteMemoryCallback } from "../worker/memoryService";
import { processJob } from "../desktop_agent/mirror_agent";

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (err: any) {
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`     ${err?.message || err}`);
  }
}

function insertMemory(db: any, row: Record<string, any>) {
  return db
    .prepare(
      `INSERT INTO memory_objects
         (id, type, title, canonical_text, summary, source, trust, sensitivity, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, 'test', ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.type || "fact",
      row.title || row.canonical_text.slice(0, 40),
      row.canonical_text,
      row.summary ?? null,
      row.trust || "high",
      row.sensitivity || "normal",
      row.created_at || new Date().toISOString(),
      row.updated_at || row.created_at || new Date().toISOString(),
      row.deleted_at ?? null
    )
    .run();
}

async function main() {
  console.log("\n=== Obsidian memory mirror ===");

  await it("formats a memory note with D1 as the canonical source", () => {
    const note = formatMemoryNote({
      id: "mem_test1",
      type: "fact",
      title: "College",
      canonical_text: "I am in 3rd year ECE",
      sensitivity: "normal",
      trust: "high",
      created_at: "2026-11-01T00:00:00.000Z",
    });
    assert.strictEqual(note.filename, "mem_test1.md");
    assert.strictEqual(note.vaultPath, "Memories/mem_test1.md");
    assert.ok(note.markdown.includes('memory_id: "mem_test1"'));
    assert.ok(note.markdown.includes("I am in 3rd year ECE"));
    assert.ok(note.markdown.includes("D1 is canonical"));
    assert.ok(!note.markdown.includes("undefined"));
  });

  await it("never enqueues private memories", async () => {
    const db = createMockD1();
    assert.strictEqual(isMirrorableMemory({ id: "mem_priv", sensitivity: "private" }), false);
    const jobId = await enqueueMemoryMirror(
      db,
      { id: "mem_priv", type: "fact", title: "secret", canonical_text: "secret", sensitivity: "private", created_at: "x" },
      "upsert"
    );
    assert.strictEqual(jobId, null);
    const count = await db.prepare("SELECT COUNT(*) as cnt FROM mirror_outbox").first<any>();
    assert.strictEqual(count.cnt, 0);
  });

  await it("enqueues an upsert job with a stable dedupe key and delete-free content", async () => {
    const db = createMockD1();
    insertMemory(db, { id: "mem_up1", canonical_text: "I prefer studying at night" });
    const row = await db.prepare("SELECT * FROM memory_objects WHERE id = 'mem_up1'").first<any>();
    const jobId = await enqueueMemoryMirror(db, row, "upsert");
    assert.ok(jobId && jobId.startsWith("job_"));
    const job = await db.prepare("SELECT * FROM mirror_outbox WHERE id = ?").bind(jobId).first<any>();
    assert.strictEqual(job.dedupe_key, "memory:mem_up1");
    assert.strictEqual(job.action, "upsert");
    assert.strictEqual(job.target_folder, "Memories");
    assert.strictEqual(job.filename, "mem_up1.md");
    assert.strictEqual(job.status, "pending");
    assert.ok(job.content.includes("I prefer studying at night"));
  });

  await it("a repeat upsert supersedes the previous pending job", async () => {
    const db = createMockD1();
    insertMemory(db, { id: "mem_up2", canonical_text: "v1" });
    const first = await enqueueMemoryMirror(
      db,
      { id: "mem_up2", type: "fact", title: "t", canonical_text: "v1", created_at: "x" },
      "upsert"
    );
    const second = await enqueueMemoryMirror(
      db,
      { id: "mem_up2", type: "fact", title: "t", canonical_text: "v2", created_at: "x" },
      "upsert"
    );
    const old = await db.prepare("SELECT status FROM mirror_outbox WHERE id = ?").bind(first).first<any>();
    const live = await db.prepare("SELECT status FROM mirror_outbox WHERE id = ?").bind(second).first<any>();
    // 'superseded' is its own terminal status: nothing failed, the newer job replaced it.
    assert.strictEqual(old.status, "superseded");
    assert.strictEqual(live.status, "pending");
  });

  await it("delete job is created only when the D1 delete commits", async () => {
    const db = createMockD1();
    insertMemory(db, { id: "mem_del1", canonical_text: "temporary fact" });

    const firstReply = await handleDeleteMemoryCallback(db, "mem_del1", new Date());
    assert.strictEqual(firstReply, "Deleted 1 memory.");

    const secondReply = await handleDeleteMemoryCallback(db, "mem_del1", new Date());
    assert.ok(secondReply.includes("already removed"));

    const jobs = await db
      .prepare("SELECT * FROM mirror_outbox WHERE dedupe_key = 'memory:mem_del1' ORDER BY created_at")
      .all<any>();
    assert.strictEqual(jobs.results.length, 1, "no second delete job after a 0-change update");
    assert.strictEqual(jobs.results[0].action, "delete");
    assert.strictEqual(jobs.results[0].content, "");
  });

  await it("reconcile enqueues live upserts and soft-delete tombstones, then skips for 24h", async () => {
    const db = createMockD1();
    insertMemory(db, { id: "mem_live", canonical_text: "live fact" });
    insertMemory(db, {
      id: "mem_gone",
      canonical_text: "gone fact",
      deleted_at: "2026-11-01T00:00:00.000Z",
    });
    insertMemory(db, { id: "mem_secret", canonical_text: "private fact", sensitivity: "private" });

    const now = new Date("2026-11-08T12:00:00.000Z");
    const first = await reconcileMemoryMirror(db, now);
    assert.deepStrictEqual(first, { upserts: 1, deletes: 1, skipped: false });

    const actions = await db
      .prepare("SELECT dedupe_key, action FROM mirror_outbox ORDER BY dedupe_key")
      .all<any>();
    assert.deepStrictEqual(
      actions.results.map((r: any) => `${r.dedupe_key}:${r.action}`),
      ["memory:mem_gone:delete", "memory:mem_live:upsert"]
    );

    const second = await reconcileMemoryMirror(db, new Date("2026-11-08T13:00:00.000Z"));
    assert.strictEqual(second.skipped, true);
  });

  await it("mirror agent deletes the note for a delete job, staying inside the vault", async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-vault-"));
    try {
      fs.mkdirSync(path.join(vault, "Memories"), { recursive: true });
      const notePath = path.join(vault, "Memories", "mem_gone.md");
      fs.writeFileSync(notePath, "---\nmemory_id: mem_gone\n---\n", "utf8");
      assert.ok(fs.existsSync(notePath));

      const state = { writtenHashes: { "Memories/mem_gone.md": "abc" } };
      const result = await processJob(
        { vaultPath: vault, serverUrl: "http://localhost", deviceToken: "t" },
        { id: "job_del", target_folder: "Memories", filename: "mem_gone.md", content: "", action: "delete" },
        state,
        path.join(vault, "mirror_agent.log")
      );

      assert.strictEqual(result.status, "delivered");
      assert.ok(!fs.existsSync(notePath), "note should be removed");
      assert.strictEqual(state.writtenHashes["Memories/mem_gone.md"], undefined);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  await it("mirror agent rejects a delete job that escapes the vault", async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-vault-"));
    try {
      const result = await processJob(
        { vaultPath: vault, serverUrl: "http://localhost", deviceToken: "t" },
        { id: "job_bad", target_folder: "Memories", filename: "..\\escape.md", content: "", action: "delete" },
        { writtenHashes: {} },
        path.join(vault, "mirror_agent.log")
      );
      assert.strictEqual(result.status, "failed");
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  await it("a late ack on a superseded job is ignored instead of reviving stale content", async () => {
    const db = createMockD1();
    insertMemory(db, { id: "mem_up3", canonical_text: "v1" });
    const first = await enqueueMemoryMirror(
      db,
      { id: "mem_up3", type: "fact", title: "t", canonical_text: "v1", created_at: "x" },
      "upsert"
    );
    await enqueueMemoryMirror(
      db,
      { id: "mem_up3", type: "fact", title: "t", canonical_text: "v2", created_at: "x" },
      "upsert"
    );

    const ackResult = await acknowledgeMirrorJob(db, first as string, {
      status: "failed",
      error: "agent could not write",
    });
    assert.strictEqual(ackResult.success, true);

    const after = await db.prepare("SELECT status, last_error FROM mirror_outbox WHERE id = ?").bind(first).first<any>();
    assert.strictEqual(after.status, "superseded");
    assert.ok(String(after.last_error).startsWith("Superseded by newer job"));
  });

  await it("retry ceiling stops a job after MIRROR_MAX_ATTEMPTS claims", async () => {
    const db = createMockD1();
    insertMemory(db, { id: "mem_retry", canonical_text: "retry me" });
    const jobId = await enqueueMemoryMirror(
      db,
      { id: "mem_retry", type: "fact", title: "t", canonical_text: "retry me", created_at: "x" },
      "upsert"
    );

    // Pretend the agent claimed it the maximum number of times without acking.
    await db
      .prepare("UPDATE mirror_outbox SET attempts = ? WHERE id = ?")
      .bind(MIRROR_MAX_ATTEMPTS, jobId)
      .run();

    await claimPendingMirrorJobs(db, "dev_test", 10);

    const job = await db.prepare("SELECT status, last_error FROM mirror_outbox WHERE id = ?").bind(jobId).first<any>();
    assert.strictEqual(job.status, "failed");
    assert.ok(String(job.last_error).includes(`Max retry attempts (${MIRROR_MAX_ATTEMPTS})`));
  });

  console.log(`\nTOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
