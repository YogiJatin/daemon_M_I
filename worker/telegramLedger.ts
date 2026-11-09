/**
 * worker/telegramLedger.ts - terminal states for the Telegram update ledger.
 *
 * The ledger row is inserted as 'received' before any work happens, which is what makes
 * a redelivered update safe. What was missing is the other end: chat turns were never
 * moved off 'received', so 76 rows looked like work permanently in flight.
 *
 * Rules this file enforces:
 * - Every accepted update ends in exactly one terminal state: processed, failed, expired.
 * - Finalisation is idempotent and never overwrites a state a handler already set.
 * - Expiry is age-bounded, so a fresh update still in flight is never expired underneath it.
 * - 'expired' is terminal: the webhook's INSERT OR IGNORE sees the existing row, answers
 *   "duplicate" and does no work, so an old update can never be replayed or re-replied.
 */

export type LedgerTerminalState = "processed" | "failed" | "expired";

/** How long a 'received'/'processing' row may stay non-terminal before it is expired. */
export const DEFAULT_UPDATE_EXPIRY_MINUTES = 15;

/**
 * Moves an accepted update to a terminal state. Only rows still in flight are touched, so
 * a handler that already recorded a specific outcome keeps it.
 */
export async function finalizeTelegramUpdate(
  db: D1Database,
  updateId: number,
  now: Date = new Date(),
  failureCode?: string | null
): Promise<boolean> {
  const status: LedgerTerminalState = failureCode ? "failed" : "processed";
  try {
    const result = await db
      .prepare(
        `UPDATE telegram_updates
            SET status = ?,
                processed_at = ?,
                outcome = COALESCE(outcome, ?),
                error_code = COALESCE(?, error_code),
                lease_expires_at = NULL
          WHERE update_id = ?
            AND status IN ('received', 'processing')`
      )
      .bind(
        status,
        now.toISOString(),
        failureCode ? "conversation_failed" : "conversation_replied",
        failureCode ?? null,
        updateId
      )
      .run();
    const changes = (result as any)?.meta?.changes ?? (result as any)?.changes ?? 0;
    return changes > 0;
  } catch {
    // Ledger bookkeeping must never fail a reply that was already sent.
    return false;
  }
}

/**
 * Expires updates that are too old to act on. Age-bounded and idempotent: it only looks at
 * rows that are still non-terminal and older than the window, so a concurrent turn in
 * flight is unaffected and repeated sweeps change nothing.
 */
export async function expireStaleTelegramUpdates(
  db: D1Database,
  now: Date = new Date(),
  maxAgeMinutes: number = DEFAULT_UPDATE_EXPIRY_MINUTES
): Promise<number> {
  // Compare through SQLite's datetime() so the ledger's "YYYY-MM-DD HH:MM:SS" rows and
  // ISO parameters are both understood; a raw string compare would treat a space as
  // smaller than "T" and expire same-day rows immediately.
  const cutoff = new Date(now.getTime() - maxAgeMinutes * 60 * 1000).toISOString();
  try {
    const result = await db
      .prepare(
        `UPDATE telegram_updates
            SET status = 'expired',
                processed_at = ?,
                outcome = 'expired_stale',
                error_code = 'expired_before_terminal',
                lease_expires_at = NULL
          WHERE status IN ('received', 'processing')
            AND datetime(received_at) < datetime(?)`
      )
      .bind(now.toISOString(), cutoff)
      .run();
    return (result as any)?.meta?.changes ?? (result as any)?.changes ?? 0;
  } catch {
    return 0;
  }
}
