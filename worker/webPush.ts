/**
 * worker/webPush.ts — Web Push Notification Fallback
 *
 * Implements fallback push notification when Telegram delivery fails
 * for high or urgent priority reminders.
 * Stores and manages push subscriptions in D1 push_subscriptions table.
 */

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
}

export async function savePushSubscription(
  db: D1Database,
  sub: PushSubscriptionData,
  userId: string = "default"
): Promise<void> {
  const id = `sub_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at`
    )
    .bind(id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userId, nowIso, nowIso)
    .run();
}

export async function removePushSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db
    .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`)
    .bind(endpoint)
    .run()
    .catch(() => {});
}

/**
 * Dispatch web push notification to all registered subscriptions as fallback
 */
export async function dispatchWebPushFallback(
  db: D1Database,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  const subs = await db
    .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions`)
    .all<{ endpoint: string; p256dh: string; auth: string }>();

  if (!subs.results || subs.results.length === 0) {
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const s of subs.results) {
    try {
      // In standard WebPush without external VAPID library, standard fetch to endpoint
      const res = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          TTL: "3600",
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 404 || res.status === 410) {
        // Expired subscription, cleanup
        await removePushSubscription(db, s.endpoint);
        failed++;
      } else if (res.ok) {
        sent++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return { sent, failed };
}
