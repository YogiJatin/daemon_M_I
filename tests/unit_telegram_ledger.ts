/**
 * tests/unit_telegram_ledger.ts - the Telegram update ledger must always reach a terminal
 * state, and an old update must never be processed twice.
 *
 * Uses the real migrations via the in-memory D1 mock, so migration 0026's 'expired' state
 * is exercised rather than assumed.
 */

import { createMockD1 } from "./mockD1";
import {
  DEFAULT_UPDATE_EXPIRY_MINUTES,
  expireStaleTelegramUpdates,
  finalizeTelegramUpdate,
} from "../worker/telegramLedger";

let pass = 0;
let fail = 0;

function assert(condition: boolean, name: string, detail?: unknown): void {
  if (condition) {
    pass += 1;
    console.log(`  PASS: ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

function sqliteNow(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function seed(db: any, updateId: number, status: string, receivedAt: Date): Promise<void> {
  await db
    .prepare("INSERT INTO telegram_updates (update_id, status, received_at) VALUES (?, ?, ?)")
    .bind(updateId, status, sqliteNow(receivedAt))
    .run();
}

async function read(db: any, updateId: number): Promise<any> {
  return db.prepare("SELECT * FROM telegram_updates WHERE update_id = ?").bind(updateId).first();
}

async function run(): Promise<void> {
  console.log("\n=== TELEGRAM LEDGER LIFECYCLE ===\n");

  const now = new Date("2026-11-09T10:00:00.000Z");

  console.log("--- 1. A replied turn becomes processed ---");
  {
    const db = createMockD1();
    await seed(db, 1, "received", new Date("2026-11-09T09:59:00Z"));
    const changed = await finalizeTelegramUpdate(db, 1, now, null);
    const row = await read(db, 1);
    assert(changed === true, "finalize reports the row it moved", changed);
    assert(row.status === "processed", "status is processed", row.status);
    assert(Boolean(row.processed_at), "processed_at is set", row.processed_at);
    assert(row.outcome === "conversation_replied", "outcome explains why", row.outcome);
  }

  console.log("--- 2. A crashed turn becomes failed ---");
  {
    const db = createMockD1();
    await seed(db, 2, "received", new Date("2026-11-09T09:59:00Z"));
    await finalizeTelegramUpdate(db, 2, now, "conversation_error");
    const row = await read(db, 2);
    assert(row.status === "failed", "status is failed", row.status);
    assert(row.error_code === "conversation_error", "error_code is recorded", row.error_code);
  }

  console.log("--- 3. Finalising is idempotent and never rewrites a handler's outcome ---");
  {
    const db = createMockD1();
    await seed(db, 3, "received", new Date("2026-11-09T09:59:00Z"));
    await finalizeTelegramUpdate(db, 3, now, null);
    const first = await read(db, 3);

    const second = await finalizeTelegramUpdate(db, 3, new Date("2026-11-09T10:05:00Z"), "late_error");
    const after = await read(db, 3);
    assert(second === false, "second finalize changes nothing", second);
    assert(after.status === first.status, "status is stable", after.status);
    assert(after.processed_at === first.processed_at, "processed_at is stable", after.processed_at);

    // A handler that already recorded a specific outcome keeps it.
    const db2 = createMockD1();
    await seed(db2, 4, "received", new Date("2026-11-09T09:59:00Z"));
    await db2
      .prepare("UPDATE telegram_updates SET status = 'processed', outcome = 'task_done' WHERE update_id = 4")
      .run();
    const kept = await finalizeTelegramUpdate(db2, 4, now, null);
    const keptRow = await read(db2, 4);
    assert(kept === false, "terminal rows are left alone", kept);
    assert(keptRow.outcome === "task_done", "the handler outcome survives", keptRow.outcome);
  }

  console.log("--- 4. Expiry is age-bounded ---");
  {
    const db = createMockD1();
    const old = new Date(now.getTime() - (DEFAULT_UPDATE_EXPIRY_MINUTES + 5) * 60 * 1000);
    const fresh = new Date(now.getTime() - 60 * 1000);
    await seed(db, 10, "received", old);
    await seed(db, 11, "processing", old);
    await seed(db, 12, "received", fresh);
    await seed(db, 13, "processed", old);

    const expired = await expireStaleTelegramUpdates(db, now);
    assert(expired === 2, "only the two stale in-flight rows expire", expired);
    const stale = await read(db, 10);
    assert(stale.status === "expired", "old received row is expired", stale.status);
    assert(stale.outcome === "expired_stale", "expiry records a reason", stale.outcome);
    assert((await read(db, 11)).status === "expired", "old processing row is expired");
    assert((await read(db, 12)).status === "received", "a fresh in-flight row is untouched");
    assert((await read(db, 13)).status === "processed", "a terminal row is untouched");

    const again = await expireStaleTelegramUpdates(db, now);
    assert(again === 0, "a second sweep is a no-op", again);
  }

  console.log("--- 5. An expired update can never be replayed ---");
  {
    const db = createMockD1();
    const old = new Date(now.getTime() - 60 * 60 * 1000);
    await seed(db, 20, "received", old);
    await expireStaleTelegramUpdates(db, now);

    // This is exactly what the webhook does before any work.
    const insert = await db
      .prepare("INSERT OR IGNORE INTO telegram_updates (update_id, status, received_at) VALUES (?, 'received', datetime('now'))")
      .bind(20)
      .run();
    const changes = insert?.meta?.changes ?? insert?.changes ?? 0;
    const row = await read(db, 20);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM telegram_updates").first();

    assert(changes === 0, "the insert is ignored for a known update", changes);
    assert(row.status === "expired", "the row stays expired, never received again", row.status);
    assert(count.n === 1, "no duplicate ledger row is created", count.n);
  }

  console.log(`\nTOTAL: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((error) => {
  console.log(`  FAIL: crashed -> ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
