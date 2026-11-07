# RUNBOOK — Personal AI OS Operations & Incident Response

This runbook documents operational procedures, diagnostics, failover modes, and maintenance drills for the Personal AI OS deployed on Cloudflare Workers and D1.

---

## 1. System Architecture Overview

- **Compute**: Cloudflare Worker (Edge modular monolith, IST timezone).
- **Primary Datastore**: Cloudflare D1 (`personal-ai-os-db`). Single source of truth.
- **Messaging Interface**: Telegram Bot API via direct webhook (`/api/v1/telegram/webhook`).
- **Desktop Agent**: Local Obsidian vault mirror (`desktop_agent/mirror_agent.ts`), zero-listener outbox puller.
- **AI Router**: Multi-tier provider fallback (Groq Primary -> Workers AI -> Deterministic Offline). Gemini is parked (`gemini_enabled=0`).

---

## 2. Real-Time Operational Inspection

Send the following commands directly in Telegram:
- `/status` — High-level operational summary: task counts, pending proposals, active memories, desktop connection status, scheduler health, and provider status.
- `/attention` — Real-time attention budget status: Pool A (reminders & re-nudges), Pool B (briefings & urgent pings), and quiet hours status.
- `/health` — Diagnostics: consecutive failure count, last scheduler run, and redelivery metrics.
- `/devices` — Lists paired desktop devices and last seen timestamps.
- `/pause` / `/resume` — Emergency pause or resume for the automated reminder loop.

---

## 3. Incident Response Playbooks

### 3.1. Scheduler Degraded / Consecutive Failures > 0
1. Inspect Cloudflare Worker logs:
   ```powershell
   npx wrangler tail personal-ai-os
   ```
2. Check `system_health` table in D1:
   ```powershell
   npx wrangler d1 execute personal-ai-os-db --remote --command="SELECT * FROM system_health WHERE id = 1;"
   ```
3. Check for stale claimed notifications with expired leases:
   ```powershell
   npx wrangler d1 execute personal-ai-os-db --remote --command="SELECT id, status, lease_expires_at FROM notification_log WHERE status = 'claimed';"
   ```
   *The scheduler automatically recovers expired leases on every 1-minute cron tick.*

### 3.2. Desktop Mirror Queue Buildup / Device Offline
1. Check device status:
   ```powershell
   npx wrangler d1 execute personal-ai-os-db --remote --command="SELECT device_name, last_seen_at, revoked_at FROM desktop_devices;"
   ```
2. Check outbox queue depth:
   ```powershell
   npx wrangler d1 execute personal-ai-os-db --remote --command="SELECT status, COUNT(*) FROM desktop_mirror_outbox GROUP BY status;"
   ```
3. Restart local desktop mirror agent:
   ```powershell
   npm run desktop:mirror
   ```
   *Single-instance lock (`.agent.lock`) prevents duplicate instances. Conflicts produce `.conflict-<timestamp>.md` without losing edits.*

### 3.3. AI Provider Outage & Degradation
- If Groq encounters rate limits (HTTP 429) or 5xx outages:
  The router automatically falls back to secondary Groq key, then Workers AI `@cf/meta/llama-3.1-8b-instruct-fast`.
- If all providers are down:
  System switches to deterministic offline code templates with `[Save as untimed task]` fallback. Zero crash.
- Gemini re-enable requires explicit owner checklist execution.

---

## 4. Secret & Credential Rotation

### 4.1. Telegram Bot Token Rotation
1. Request new token from `@BotFather` on Telegram.
2. Update Worker secret:
   ```powershell
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   ```
3. Set Webhook with new secret token:
   ```powershell
   curl -F "url=https://personal-ai-os.jatin-personal-ai.workers.dev/api/v1/telegram/webhook" -F "secret_token=<NEW_SECRET>" https://api.telegram.org/bot<NEW_TOKEN>/setWebhook
   ```

### 4.2. Revoking Desktop Device Access
In Telegram send:
```text
/revoke <device_id>
```
Or execute in D1:
```powershell
npx wrangler d1 execute personal-ai-os-db --remote --command="UPDATE desktop_devices SET revoked_at = datetime('now') WHERE id = '<device_id>';"
```

---

## 5. Maintenance & Disaster Recovery

- **Scheduled Data Retention**:
  - `chat_messages`: Purged after 30 days.
  - `telegram_updates`: Purged after 7 days.
  - `desktop_mirror_outbox` (delivered): Purged after 30 days.
- **Database Backup Drill**:
  ```powershell
  npx tsx scripts/backup_drill.ts
  ```
- **Quiet Hours Enforcement**:
  - 23:00 to 07:00 IST. Suppresses briefings, suggestions, and re-nudges.
  - User-scheduled first-fire reminders are NEVER suppressed or capped.
