/**
 * worker/heartbeat.ts — Deterministic System Health & Heartbeat Engine
 *
 * Implements Phase 1 (Block 4) periodic heartbeat:
 * - Executes on every 15-minute cron mark (minute % 15 == 0).
 * - Scans four system invariants:
 *   1. Tasks overdue > 24 hours.
 *   2. Pending task proposals unreviewed > 24 hours.
 *   3. Desktop mirror agent offline > 48 hours.
 *   4. LLM provider outages degraded > 60 minutes.
 * - Bound to Pool B urgent ping budget (max 1/day).
 * - Flap prevention: suppresses repeated alerts for the same condition within 24 hours.
 * - ZERO LLM calls: pure deterministic D1 checks.
 */

import { canDispatchAttention, logAttentionSend } from "./attention";
import { sendTelegramMessage } from "./telegram";

export interface HeartbeatIssue {
  type: "overdue_tasks" | "stale_proposals" | "desktop_offline" | "provider_outage" | "backup_stale";
  description: string;
}

export interface HeartbeatResult {
  checked: boolean;
  issuesFound: number;
  alertSent: boolean;
  reason?: string;
}

export async function runDeterministicHeartbeat(
  db: D1Database,
  botToken?: string,
  ownerChatId?: string | number,
  now: Date = new Date()
): Promise<HeartbeatResult> {
  const minute = now.getMinutes();
  // Only evaluate on 15-minute marks
  if (minute % 15 !== 0) {
    return { checked: false, issuesFound: 0, alertSent: false, reason: "Not on 15m mark" };
  }

  const nowIso = now.toISOString();
  const oneDayAgoIso = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const twoDaysAgoIso = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const oneHourAgoIso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const issues: HeartbeatIssue[] = [];

  // 1. Check tasks overdue > 24 hours
  const overdueTasks = await db
    .prepare(
      `SELECT count(*) as cnt FROM tasks
       WHERE status = 'open'
         AND due_date_time_local IS NOT NULL
         AND due_date_time_local < ?`
    )
    .bind(oneDayAgoIso.slice(0, 16))
    .first<{ cnt: number }>();

  if (overdueTasks && overdueTasks.cnt > 0) {
    issues.push({
      type: "overdue_tasks",
      description: `${overdueTasks.cnt} task(s) overdue for more than 24 hours`,
    });
  }

  // 2. Check pending task proposals > 24 hours
  const staleProps = await db
    .prepare(
      `SELECT count(*) as cnt FROM task_proposals
       WHERE status = 'pending' AND created_at < ?`
    )
    .bind(oneDayAgoIso)
    .first<{ cnt: number }>();

  if (staleProps && staleProps.cnt > 0) {
    issues.push({
      type: "stale_proposals",
      description: `${staleProps.cnt} proposal(s) awaiting review for > 24 hours`,
    });
  }

  // 3. Check desktop mirror agent offline > 48 hours
  const desktopDevices = await db
    .prepare(
      `SELECT device_name, last_seen_at FROM desktop_devices
       WHERE revoked_at IS NULL AND last_seen_at < ?`
    )
    .bind(twoDaysAgoIso)
    .all<{ device_name: string; last_seen_at: string }>();

  if (desktopDevices.results && desktopDevices.results.length > 0) {
    const names = desktopDevices.results.map((d) => d.device_name).join(", ");
    issues.push({
      type: "desktop_offline",
      description: `Desktop mirror agent (${names}) offline for > 48 hours`,
    });
  }

  // 4. Check provider outages degraded > 60 minutes
  const failedProviders = await db
    .prepare(
      `SELECT provider_name, last_failure_at FROM provider_health
       WHERE is_healthy = 0 AND last_failure_at < ?`
    )
    .bind(oneHourAgoIso)
    .all<{ provider_name: string; last_failure_at: string }>();

  if (failedProviders.results && failedProviders.results.length > 0) {
    const pNames = failedProviders.results.map((p) => p.provider_name).join(", ");
    issues.push({
      type: "provider_outage",
      description: `AI Provider (${pNames}) degraded/outage for > 60 minutes`,
    });
  }

  // 5. Check backup older than 36 hours (Phase 3)
  const thirtySixHoursAgo = new Date(now.getTime() - 36 * 3600 * 1000).toISOString();
  const backupRow = await db
    .prepare("SELECT value FROM settings WHERE key = 'last_backup_at'")
    .first<{ value: string }>()
    .catch(() => null);

  if (backupRow?.value && backupRow.value < thirtySixHoursAgo) {
    issues.push({
      type: "backup_stale",
      description: `Latest database backup is older than 36 hours (${backupRow.value})`,
    });
  }

  // Update last_checked_at
  await db
    .prepare(
      `INSERT INTO heartbeat_state (key, last_checked_at, metadata)
       VALUES ('system_health', ?, ?)
       ON CONFLICT(key) DO UPDATE SET last_checked_at = excluded.last_checked_at, metadata = excluded.metadata`
    )
    .bind(nowIso, JSON.stringify({ issuesFound: issues.length }))
    .run()
    .catch(() => {});

  if (issues.length === 0) {
    return { checked: true, issuesFound: 0, alertSent: false };
  }

  // If issues exist, check 24-hour suppression per issue type
  const stateRow = await db
    .prepare(`SELECT last_alert_at FROM heartbeat_state WHERE key = 'urgent_alert'`)
    .first<{ last_alert_at: string }>();

  if (stateRow?.last_alert_at) {
    const lastAlertTime = new Date(stateRow.last_alert_at).getTime();
    if (now.getTime() - lastAlertTime < 24 * 3600 * 1000) {
      return {
        checked: true,
        issuesFound: issues.length,
        alertSent: false,
        reason: "Suppressed: Alert already sent within last 24h",
      };
    }
  }

  // Check attention budget (urgent_ping)
  const attn = await canDispatchAttention(db, "urgent_ping", now);
  if (!attn.allowed) {
    return {
      checked: true,
      issuesFound: issues.length,
      alertSent: false,
      reason: attn.reason,
    };
  }

  if (!botToken || !ownerChatId) {
    return { checked: true, issuesFound: issues.length, alertSent: false, reason: "No bot token" };
  }

  // Format alert message
  const alertText = [
    `⚠️ *System Heartbeat Alert*`,
    "",
    ...issues.map((i) => `• ${i.description}`),
    "",
    `_Check /status or /attention for full operational details._`,
  ].join("\n");

  const sendRes = await sendTelegramMessage(botToken, ownerChatId, alertText, undefined, { parseMode: "Markdown" });

  if (sendRes.sent) {
    await db
      .prepare(
        `INSERT INTO heartbeat_state (key, last_checked_at, last_alert_at, metadata)
         VALUES ('urgent_alert', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET last_alert_at = excluded.last_alert_at, metadata = excluded.metadata`
      )
      .bind(nowIso, nowIso, JSON.stringify(issues))
      .run()
      .catch(() => {});

    await logAttentionSend(
      db,
      "telegram",
      "pool_b",
      "urgent_ping",
      ownerChatId,
      alertText,
      sendRes.telegramMessageId,
      now
    );

    return { checked: true, issuesFound: issues.length, alertSent: true };
  }

  return { checked: true, issuesFound: issues.length, alertSent: false, reason: sendRes.error };
}
