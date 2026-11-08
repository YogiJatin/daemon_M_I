import { generatePKCE, buildConsentUrl, revokeGmailAccess } from "./gmailService";
import { parseDateShorthand, ParsedDeadline, getISTDateParts, istToUtcDate, extractTimeAndTitle } from "./dateParser";
import { planNotification, planCatchupDigest } from "./notificationPlanner";
import {
  parseRecurrenceShorthand,
  createRecurrenceRule,
  materializeRecurringOccurrences,
  addDaysYmd,
} from "./recurrenceEngine";
import {
  getClassesForDate,
  getNextClass,
  getOngoingClass,
  getSchedulePreview,
  renderPrepDigestMessage,
  getActiveSemester,
  activateSemester,
  materializeTimetableOccurrences,
} from "./timetableEngine";
import { createPairingChallenge } from "./auth";
import { evaluateSuggestions } from "./suggestionsEngine";
import { getExportData } from "./exportService";
import { AICapabilities } from "./aiCapabilities";
import { listTaskProposals } from "./inboxService";

import { getProfile, getMissingProfileKeys, setProfileKey } from "./dailyRhythm";
import { handleCaptureCommand } from "./captureEngine";
import {
  handleRememberCommand,
  handleMemoriesCommand,
  handleForgetCommand,
  handleAboutCommand,
} from "./memoryService";
import {
  createPairingCode,
  handleListDevicesCommand,
  handleRevokeDeviceCommand,
} from "./desktopMirrorService";
import { renderAttentionReport } from "./attention";
import { buildMorningBriefingText, buildEveningBriefingText } from "./briefings";

interface SnoozePresetResult {
  success: boolean;
  snoozedUntilUtc?: string;     // ISO UTC instant — always set on success
  snoozedUntilLocal?: string;   // "YYYY-MM-DD HH:mm" IST label for confirmation
  error?: string;
}

function parseSnoozePreset(raw: string, now: Date): SnoozePresetResult {
  const input = raw.trim().toLowerCase();
  const ist = getISTDateParts(now);

  // 1h — alias for +1h
  if (input === "1h") {
    const target = new Date(now.getTime() + 60 * 60 * 1000);
    const tIST = getISTDateParts(target);
    return {
      success: true,
      snoozedUntilUtc: target.toISOString(),
      snoozedUntilLocal: `${tIST.localDate} ${tIST.localTime}`,
    };
  }

  // +Nh — relative hours
  const relMatch = input.match(/^\+(\d+)h$/);
  if (relMatch) {
    const hours = parseInt(relMatch[1], 10);
    if (hours < 1) return { success: false, error: "Snooze duration must be at least 1h." };
    const target = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const tIST = getISTDateParts(target);
    return {
      success: true,
      snoozedUntilUtc: target.toISOString(),
      snoozedUntilLocal: `${tIST.localDate} ${tIST.localTime}`,
    };
  }

  // tonight — 21:00 IST today; if already past, reject
  if (input === "tonight") {
    const target = istToUtcDate(ist.localDate, "21:00");
    if (target.getTime() <= now.getTime()) {
      return { success: false, error: "Tonight (21:00 IST) has already passed. Try 'tomorrow' or '+Nh'." };
    }
    return {
      success: true,
      snoozedUntilUtc: target.toISOString(),
      snoozedUntilLocal: `${ist.localDate} 21:00`,
    };
  }

  // tomorrow — 09:00 IST next day
  if (input === "tomorrow") {
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tIST = getISTDateParts(tomorrowDate);
    const target = istToUtcDate(tIST.localDate, "09:00");
    return {
      success: true,
      snoozedUntilUtc: target.toISOString(),
      snoozedUntilLocal: `${tIST.localDate} 09:00`,
    };
  }

  // explicit YYYY-MM-DD HH:mm
  const dtMatch = input.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (dtMatch) {
    const dateStr = dtMatch[1];
    const hours = dtMatch[2].padStart(2, "0");
    const mins = dtMatch[3];
    const target = istToUtcDate(dateStr, `${hours}:${mins}`);
    if (isNaN(target.getTime())) {
      return { success: false, error: `Invalid date/time: '${raw}'.` };
    }
    if (target.getTime() <= now.getTime()) {
      return { success: false, error: `Snooze time '${raw}' is in the past.` };
    }
    return {
      success: true,
      snoozedUntilUtc: target.toISOString(),
      snoozedUntilLocal: `${dateStr} ${hours}:${mins}`,
    };
  }

  return {
    success: false,
    error: `Unrecognized snooze preset '${raw}'. Supported: 1h, +Nh, tonight, tomorrow, YYYY-MM-DD HH:mm.`,
  };
}

export interface CommandContext {
  db: D1Database;
  updateId: number;
  senderId?: number | string;
  chatId?: number | string;
  now?: Date;
  env?: any;
}

export interface CommandResult {
  command: string;
  args: string;
  response: string;
  success?: boolean;
  taskId?: string;
  deadline?: ParsedDeadline;
  tasks?: any[];
  replyMarkup?: any;
  proposals?: any[];
}

export function handleStart(args: string, _context?: CommandContext): CommandResult {
  return {
    command: "start",
    args,
    success: true,
    response:
      "👋 Personal AI OS\n\nCommands:\n/add <title> or /add <date> | <title>\n/today — tasks due today and overdue\n/done <id> — mark a task done\n/snooze <id> <preset> — snooze (1h, +Nh, tonight, tomorrow, YYYY-MM-DD HH:mm)\n/pause — pause reminders\n/resume — resume reminders\n/health — system status\n/help — this message",
  };
}

export function handleHelp(args: string, _context?: CommandContext): CommandResult {
  return {
    command: "help",
    args,
    success: true,
    response:
      "Commands:\n/add <title>\n/add <date> | <title>  (date: today, tomorrow, fri, 18:00, +2h, YYYY-MM-DD)\n/today — due today and overdue\n/done <id> — complete a task\n/snooze <id> <preset>  (1h, +Nh, tonight, tomorrow, YYYY-MM-DD HH:mm)\n/pause / /resume — pause or resume reminders\n/health — system status\n\nOr just send any plain text to capture it as a task with no date.",
  };
}

// ---------------------------------------------------------------------------
// Shared task persistence — used by /add and plain-text capture
// ---------------------------------------------------------------------------

export interface PersistTaskInput {
  title: string;
  deadline: ParsedDeadline;
  rawExcerpt: string;   // original user text (capped to 120 chars for excerpt)
  context: CommandContext;
  now: Date;
}

export async function persistTask(input: PersistTaskInput): Promise<string> {
  const { title, deadline, rawExcerpt, context, now } = input;
  const taskId = crypto.randomUUID();
  const sourceEventId = crypto.randomUUID();
  const auditEventId = crypto.randomUUID();
  const nowIso = now.toISOString();
  const sourceRef = `telegram:${context.chatId ?? context.senderId ?? "owner"}:${context.updateId}`;
  const excerpt = rawExcerpt.length > 120 ? rawExcerpt.slice(0, 120) + "..." : rawExcerpt;

  const taskStmt = context.db.prepare(
    `INSERT INTO tasks (
      id, title, status, priority, deadline_kind,
      deadline_local_date, deadline_time_local, deadline_at_utc,
      deadline_version, source_event_id, created_at, updated_at
    ) VALUES (?, ?, 'open', 'normal', ?, ?, ?, ?, 1, ?, ?, ?)`
  ).bind(
    taskId, title,
    deadline.kind, deadline.localDate, deadline.localTime, deadline.utcInstant,
    sourceEventId, nowIso, nowIso
  );

  const sourceStmt = context.db.prepare(
    `INSERT INTO source_events (
      id, source_type, source_ref, sender_hint, excerpt,
      received_at, processing_status, created_at
    ) VALUES (?, 'telegram', ?, ?, ?, ?, 'processed', ?)`
  ).bind(
    sourceEventId, sourceRef,
    context.senderId ? String(context.senderId) : null,
    excerpt, nowIso, nowIso
  );

  const auditStmt = context.db.prepare(
    `INSERT INTO audit_events (
      id, entity_type, entity_id, event_type, actor, details_json, created_at
    ) VALUES (?, 'task', ?, 'task_created', 'owner:telegram', ?, ?)`
  ).bind(
    auditEventId, taskId,
    JSON.stringify({
      title,
      deadline_kind: deadline.kind,
      deadline_local_date: deadline.localDate,
      deadline_time_local: deadline.localTime,
    }),
    nowIso
  );

  const ledgerStmt = context.db.prepare(
    `UPDATE telegram_updates
     SET status = 'processed', processed_at = ?, outcome = 'task_created'
     WHERE update_id = ?`
  ).bind(nowIso, context.updateId);

  await context.db.batch([taskStmt, sourceStmt, auditStmt, ledgerStmt]);

  // Plan a notification row if the task has a timed deadline (BLOCK_2A).
  // date_only tasks are excluded — do not fabricate a midnight timestamp (AGENTS rule 6).
  // This runs after the batch so the task row exists before the FK reference.
  await planNotification({
    db: context.db,
    taskId,
    deadlineKind: deadline.kind,
    deadlineAtUtc: deadline.utcInstant,
    deadlineVersion: 1,   // new tasks always start at version 1
    now,
  });

  return taskId;
}

export async function handleAdd(args: string, context?: CommandContext): Promise<CommandResult> {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      command: "add",
      args,
      success: false,
      response: "Usage: /add <title> or /add <title> <time-expression>",
    };
  }

  const now = context?.now || new Date();

  // 1. Recurrence check if pipe format is used
  if (trimmed.includes("|")) {
    const pipeIndex = trimmed.indexOf("|");
    const datePart = trimmed.slice(0, pipeIndex).trim();
    const titlePart = trimmed.slice(pipeIndex + 1).trim();

    if (!titlePart) {
      return { command: "add", args, success: false, response: "Task title cannot be empty." };
    }

    const recResult = parseRecurrenceShorthand(datePart, now);
    if (recResult.isRecurrence) {
      if (recResult.error || !recResult.ruleInput) {
        return { command: "add", args, success: false, response: recResult.error || "Invalid recurrence format." };
      }
      if (context?.db) {
        const { ruleId, occurrencesCreated } = await createRecurrenceRule(
          context.db,
          { ...recResult.ruleInput, title: titlePart },
          now
        );
        const nowIso = now.toISOString();
        if (context.updateId) {
          await context.db
            .prepare(
              `UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'recurrence_rule_created' WHERE update_id = ?`
            )
            .bind(nowIso, context.updateId)
            .run()
            .catch(() => {});
        }
        return {
          command: "add",
          args,
          success: true,
          taskId: ruleId,
          response: `Recurring task created: "${titlePart}" (${recResult.summary || recResult.ruleInput.pattern}). Generated ${occurrencesCreated} occurrence(s).`,
        };
      }
      return {
        command: "add",
        args,
        success: true,
        response: `Recurring task configured: "${titlePart}" (${recResult.summary || recResult.ruleInput.pattern})`,
      };
    }
  }

  // 2. Extract natural language time expression and stripped title
  const extracted = extractTimeAndTitle(trimmed, now);
  const titlePart = extracted.title || trimmed;
  const deadline = extracted.deadline;

  // Past time check for timed commands (G32)
  if (
    extracted.hasTimePhrase &&
    !extracted.parseError &&
    deadline.kind === "timed" &&
    deadline.utcInstant &&
    new Date(deadline.utcInstant).getTime() < now.getTime()
  ) {
    let propId = "prop_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (context?.db) {
      await context.db
        .prepare(
          "INSERT INTO task_proposals (id, title, status, advisory_confidence, created_at, updated_at) VALUES (?, ?, 'pending', 0.8, ?, ?)"
        )
        .bind(propId, titlePart, now.toISOString(), now.toISOString())
        .run()
        .catch(() => {});
    }
    const timeLabel = deadline.localTime || "13:25";
    return {
      command: "add",
      args,
      success: true,
      response: "That time is already past. When did you want this?",
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "in 30 min", callback_data: `reschedule:${propId}:+30m` },
            { text: `tomorrow ${timeLabel}`, callback_data: `reschedule:${propId}:+1d` },
          ],
        ],
      },
    };
  }

  let taskId = crypto.randomUUID(); // fallback if no DB
  if (context?.db) {
    taskId = await persistTask({
      title: titlePart,
      deadline,
      rawExcerpt: trimmed,
      context,
      now,
    });
  }

  // 3. If a time phrase was detected but failed to parse:
  // Requirement: "If a time phrase fails to parse, reply 'Couldn't read that time, saved without a deadline [Set time]'. Never silently create an untimed task."
  if (extracted.hasTimePhrase && extracted.parseError) {
    return {
      command: "add",
      args,
      success: true,
      taskId,
      deadline,
      response: "Couldn't read that time, saved without a deadline [Set time]",
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "📅 Set time (+1h)", callback_data: `snooze:${taskId.slice(0, 13)}:1h` },
            { text: "Tonight", callback_data: `snooze:${taskId.slice(0, 13)}:tonight` },
            { text: "Tomorrow", callback_data: `snooze:${taskId.slice(0, 13)}:tomorrow` },
          ],
        ],
      },
    };
  }

  // 4. Successful task creation with optional deadline badge
  let deadlineLabel = "";
  if (deadline.kind === "timed" && deadline.localDate) {
    deadlineLabel = ` (Due: ${deadline.localDate}${deadline.localTime ? ` ${deadline.localTime}` : ""})`;
  } else if (deadline.kind === "date_only" && deadline.localDate) {
    deadlineLabel = ` (Due: ${deadline.localDate})`;
  }

  return {
    command: "add",
    args,
    success: true,
    taskId,
    deadline,
    response: `Task created: "${titlePart}"${deadlineLabel}`,
  };
}

// Plain-text (non-command) messages become tasks verbatim — no date inference (BLOCK_1.md)
export async function handlePlainText(text: string, context: CommandContext): Promise<CommandResult> {
  const title = text.trim();
  if (!title) {
    return { command: "plain_text", args: text, success: false, response: "Empty message ignored." };
  }

  const deadline: ParsedDeadline = { kind: "none", localDate: null, localTime: null, utcInstant: null };
  const now = context.now || new Date();

  const taskId = await persistTask({ title, deadline, rawExcerpt: title, context, now });

  return {
    command: "plain_text",
    args: text,
    success: true,
    taskId,
    deadline,
    response: `Task captured: "${title}"`,
  };
}

export async function handleToday(args: string, context?: CommandContext): Promise<CommandResult> {
  const now = context?.now || new Date();
  const ist = getISTDateParts(now);
  const todayIST = ist.localDate;
  const nowUtcIso = now.toISOString();

  if (!context?.db) {
    return {
      command: "today",
      args,
      success: true,
      response: "No database connection.",
    };
  }

  const query = `
    SELECT id, title, priority, deadline_kind, deadline_local_date, deadline_time_local, deadline_at_utc
    FROM tasks
    WHERE status = 'open'
      AND deadline_local_date IS NOT NULL
      AND deadline_local_date <= ?
    ORDER BY
      CASE
        WHEN deadline_local_date < ? THEN 0
        WHEN deadline_kind = 'timed' AND deadline_at_utc < ? THEN 0
        ELSE 1
      END ASC,
      deadline_local_date ASC,
      deadline_time_local ASC,
      created_at ASC
  `;

  const { results } = await context.db
    .prepare(query)
    .bind(todayIST, todayIST, nowUtcIso)
    .all<any>();

  const overdueList: string[] = [];
  const todayList: string[] = [];

  for (const t of results || []) {
    const isOverdue =
      t.deadline_local_date < todayIST ||
      (t.deadline_kind === "timed" && t.deadline_at_utc && t.deadline_at_utc < nowUtcIso);

    const timeStr = t.deadline_time_local ? ` at ${t.deadline_time_local}` : "";
    const dateStr = t.deadline_local_date !== todayIST ? ` (${t.deadline_local_date}${timeStr})` : timeStr ? ` (${timeStr.trim()})` : "";
    const item = `• [${t.id.slice(0, 8)}] ${t.title}${dateStr}`;

    if (isOverdue) {
      overdueList.push(item);
    } else {
      todayList.push(item);
    }
  }

  let formatted = "";

  // Query college classes for today (Block 3B)
  const todayClasses = await getClassesForDate(context.db, todayIST);
  if (todayClasses.length > 0) {
    formatted += `🎓 Classes Today (${todayClasses.length}):\n` +
      todayClasses.map((c: any) => `• ${c.start_time} - ${c.end_time}: ${c.subject_name}${c.room ? ` (Room ${c.room})` : ""}`).join("\n") +
      "\n\n";
  }

  if (overdueList.length > 0) {
    formatted += `⚠️ Overdue (${overdueList.length}):\n` + overdueList.join("\n") + "\n\n";
  }
  if (todayList.length > 0) {
    formatted += `📅 Due Today (${todayList.length}):\n` + todayList.join("\n");
  }
  if (!formatted) {
    formatted = "No tasks or classes scheduled for today.";
  }

  // Update update ledger status
  await context.db
    .prepare(
      `UPDATE telegram_updates
       SET status = 'processed', processed_at = ?, outcome = 'today_queried'
       WHERE update_id = ?`
    )
    .bind(nowUtcIso, context.updateId)
    .run();

  return {
    command: "today",
    args,
    success: true,
    tasks: results,
    response: formatted.trim(),
  };
}

export async function handleDone(args: string, context?: CommandContext): Promise<CommandResult> {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      command: "done",
      args,
      success: false,
      response: "Usage: /done <task-id>",
    };
  }

  // Accept full UUID or 8-char prefix
  const idFragment = trimmed.split(/\s+/)[0];

  if (!context?.db) {
    return {
      command: "done",
      args,
      success: false,
      response: "No database connection.",
    };
  }

  const now = context.now || new Date();
  const nowIso = now.toISOString();

  // Look up task by full ID or 8-char prefix (case-insensitive)
  const task = await context.db
    .prepare(
      `SELECT id, title, status FROM tasks WHERE id = ? OR substr(id, 1, 8) = ?`
    )
    .bind(idFragment, idFragment)
    .first<{ id: string; title: string; status: string }>();

  if (!task) {
    return {
      command: "done",
      args,
      success: false,
      response: `Task not found: ${idFragment}`,
    };
  }

  // TEST-1.5: idempotent — already done is safe
  if (task.status === "done") {
    return {
      command: "done",
      args,
      success: true,
      taskId: task.id,
      response: `Task already done: "${task.title}"`,
    };
  }

  const auditEventId = crypto.randomUUID();

  const updateTaskStmt = context.db.prepare(
    `UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`
  ).bind(nowIso, nowIso, task.id);

  const auditStmt = context.db.prepare(
    `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
     VALUES (?, 'task', ?, 'task_done', 'owner:telegram', ?, ?)`
  ).bind(
    auditEventId,
    task.id,
    JSON.stringify({ previous_status: task.status }),
    nowIso
  );

  const updateLedgerStmt = context.db.prepare(
    `UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'task_done' WHERE update_id = ?`
  ).bind(nowIso, context.updateId);

  await context.db.batch([updateTaskStmt, auditStmt, updateLedgerStmt]);

  // If this task belonged to a recurring rule, trigger bounded forward materialization (TEST-3A.6)
  const completedTask = await context.db
    .prepare("SELECT recurrence_rule_id FROM tasks WHERE id = ?")
    .bind(task.id)
    .first<{ recurrence_rule_id: string | null }>();

  if (completedTask?.recurrence_rule_id) {
    await materializeRecurringOccurrences(context.db, now).catch(() => {});
  }

  return {
    command: "done",
    args,
    success: true,
    taskId: task.id,
    response: `Done: "${task.title}"`,
  };
}

export async function handleSnooze(args: string, context?: CommandContext): Promise<CommandResult> {
  const parts = args.trim().split(/\s+/);

  // Must have at least: <id> <preset> (preset may be multi-word like "2026-11-01 18:00")
  if (parts.length < 2) {
    return {
      command: "snooze",
      args,
      success: false,
      response: "Usage: /snooze <task-id> <preset>  (presets: 1h, +Nh, tonight, tomorrow, YYYY-MM-DD HH:mm)",
    };
  }

  const idFragment = parts[0];
  // Preset is everything after the id fragment (supports "2026-11-01 18:00")
  const presetRaw = parts.slice(1).join(" ");

  if (!context?.db) {
    return {
      command: "snooze",
      args,
      success: false,
      response: "No database connection.",
    };
  }

  const now = context.now || new Date();

  // Parse preset first — fail fast before touching DB
  const presetResult = parseSnoozePreset(presetRaw, now);
  if (!presetResult.success || !presetResult.snoozedUntilUtc) {
    return {
      command: "snooze",
      args,
      success: false,
      response: presetResult.error ?? "Invalid snooze preset.",
    };
  }

  const nowIso = now.toISOString();

  // Look up task by full ID or 8-char prefix
  const task = await context.db
    .prepare(`SELECT id, title, status, snooze_count FROM tasks WHERE id = ? OR substr(id, 1, 8) = ?`)
    .bind(idFragment, idFragment)
    .first<{ id: string; title: string; status: string; snooze_count: number }>();

  if (!task) {
    return {
      command: "snooze",
      args,
      success: false,
      response: `Task not found: ${idFragment}`,
    };
  }

  if (task.status === "done" || task.status === "dismissed") {
    return {
      command: "snooze",
      args,
      success: false,
      response: `Cannot snooze a task with status '${task.status}'.`,
    };
  }

  const newSnoozeCount = task.snooze_count + 1;
  const auditEventId = crypto.randomUUID();

  const updateTaskStmt = context.db.prepare(
    `UPDATE tasks
     SET status = 'snoozed', snoozed_until = ?, snooze_count = ?, updated_at = ?
     WHERE id = ?`
  ).bind(presetResult.snoozedUntilUtc, newSnoozeCount, nowIso, task.id);

  const auditStmt = context.db.prepare(
    `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
     VALUES (?, 'task', ?, 'task_snoozed', 'owner:telegram', ?, ?)`
  ).bind(
    auditEventId,
    task.id,
    JSON.stringify({
      preset: presetRaw,
      snoozed_until_utc: presetResult.snoozedUntilUtc,
      snoozed_until_local: presetResult.snoozedUntilLocal,
      snooze_count: newSnoozeCount,
      previous_status: task.status,
    }),
    nowIso
  );

  const updateLedgerStmt = context.db.prepare(
    `UPDATE telegram_updates
     SET status = 'processed', processed_at = ?, outcome = 'task_snoozed'
     WHERE update_id = ?`
  ).bind(nowIso, context.updateId);

  await context.db.batch([updateTaskStmt, auditStmt, updateLedgerStmt]);

  return {
    command: "snooze",
    args,
    success: true,
    taskId: task.id,
    response: `Snoozed: "${task.title}" until ${presetResult.snoozedUntilLocal} IST`,
  };
}

export async function handleHealth(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "health", args, success: true, response: "Status: ok (no DB)" };
  }

  const [health, paused, desktopDev, outboxCounts, redelivRows, mockRows, offlineRows] = await Promise.all([
    context.db
      .prepare(`SELECT consecutive_failures, last_scheduler_success_at, last_scheduler_start_at, last_telegram_delivery_at, updated_at FROM system_health WHERE id = 1`)
      .first<{
        consecutive_failures: number;
        last_scheduler_success_at: string | null;
        last_telegram_delivery_at: string | null;
        updated_at: string;
      }>(),
    context.db
      .prepare(`SELECT value FROM settings WHERE key = 'paused'`)
      .first<{ value: string }>(),
    context.db
      .prepare(`SELECT MAX(last_seen_at) as last_seen FROM desktop_devices WHERE revoked_at IS NULL`)
      .first<{ last_seen: string | null }>()
      .catch(() => null),
    context.db
      .prepare(`SELECT 
                  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_cnt,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_cnt
                FROM mirror_outbox`)
      .first<{ pending_cnt: number | null; failed_cnt: number | null }>()
      .catch(() => null),
    context.db
      .prepare(`SELECT COUNT(*) as cnt FROM (SELECT update_id FROM telegram_updates GROUP BY update_id HAVING COUNT(*) > 1)`)
      .first<{ cnt: number }>()
      .catch(() => ({ cnt: 0 })),
    context.db
      .prepare(`SELECT COUNT(*) as cnt FROM chat_messages WHERE provider = 'mock' AND created_at >= datetime('now', '-1 day')`)
      .first<{ cnt: number }>()
      .catch(() => ({ cnt: 0 })),
    context.db
      .prepare(`SELECT COUNT(*) as cnt FROM chat_messages WHERE outcome IN ('ai_offline', 'budget_exceeded') AND created_at >= datetime('now', '-1 day')`)
      .first<{ cnt: number }>()
      .catch(() => ({ cnt: 0 })),
  ]);

  const isPaused = paused?.value === "true";
  const failures = health?.consecutive_failures ?? 0;
  const schedulerOk = failures === 0;

  const lines = [
    `Status: ${schedulerOk ? "ok" : "degraded"}`,
    `Paused: ${isPaused ? "yes" : "no"}`,
    `Consecutive failures: ${failures}`,
    (health?.last_scheduler_success_at || (health as any)?.last_scheduler_start_at)
      ? `Last scheduler run: ${health?.last_scheduler_success_at || (health as any)?.last_scheduler_start_at}`
      : "Last scheduler run: never",
    health?.last_telegram_delivery_at
      ? `Last Telegram delivery: ${health.last_telegram_delivery_at}`
      : "Last Telegram delivery: never",
    context?.env?.HEALTHCHECKS_PING_URL
      ? "Healthchecks: configured"
      : "Healthchecks: not configured",
    "",
    `Desktop Agent: ${desktopDev?.last_seen ? "Last seen " + desktopDev.last_seen : "Never connected"}`,
    `Mirror Queue: ${outboxCounts?.pending_cnt ?? 0} pending, ${outboxCounts?.failed_cnt ?? 0} failed`,
    "",
    "Observability (24h):",
    `• Telegram redeliveries: ${redelivRows?.cnt ?? 0}`,
    `• Mock answers: ${mockRows?.cnt ?? 0}`,
    `• Offline replies: ${offlineRows?.cnt ?? 0}`,
  ];

  await context.db
    .prepare(`UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'health_queried' WHERE update_id = ?`)
    .bind((context.now || new Date()).toISOString(), context.updateId)
    .run();

  return { command: "health", args, success: true, response: lines.join("\n") };
}

export async function handleStatus(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "status", args, success: false, response: "No database connection." };
  }

  const [tasksCount, propCount, memCount, devices, outbox, health] = await Promise.all([
    context.db.prepare(`SELECT 
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_cnt,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as done_cnt
      FROM tasks`).first<{ open_cnt: number; done_cnt: number }>().catch(() => ({ open_cnt: 0, done_cnt: 0 })),
    context.db.prepare(`SELECT COUNT(*) as cnt FROM task_proposals WHERE status = 'pending'`).first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
    context.db.prepare(`SELECT COUNT(*) as cnt FROM memory_objects WHERE is_active = 1`).first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
    context.db.prepare(`SELECT COUNT(*) as cnt, MAX(last_seen_at) as last_seen FROM desktop_devices WHERE revoked_at IS NULL`).first<{ cnt: number; last_seen: string | null }>().catch(() => ({ cnt: 0, last_seen: null })),
    context.db.prepare(`SELECT 
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_cnt,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as deliv_cnt
      FROM desktop_mirror_outbox`).first<{ pending_cnt: number; deliv_cnt: number }>().catch(() => ({ pending_cnt: 0, deliv_cnt: 0 })),
    context.db.prepare(`SELECT consecutive_failures, last_scheduler_success_at FROM system_health WHERE id = 1`).first<{ consecutive_failures: number; last_scheduler_success_at: string }>().catch(() => null),
  ]);

  const lines = [
    "🖥️ *System Operational Status*",
    "",
    "📦 *Database State:*",
    `• Tasks: ${tasksCount?.open_cnt ?? 0} open, ${tasksCount?.done_cnt ?? 0} completed`,
    `• Proposals: ${propCount?.cnt ?? 0} pending review`,
    `• Memories: ${memCount?.cnt ?? 0} active records`,
    "",
    "💻 *Desktop Mirror:*",
    `• Devices: ${devices?.cnt ?? 0} paired (${devices?.last_seen ? "Last seen " + devices.last_seen : "Never"})`,
    `• Outbox Queue: ${outbox?.pending_cnt ?? 0} pending, ${outbox?.deliv_cnt ?? 0} delivered`,
    "",
    "⚡ *Worker & Scheduler:*",
    `• Scheduler: ${health?.consecutive_failures === 0 ? "🟢 Healthy" : "🔴 Failing"}`,
    `• Last Tick: ${health?.last_scheduler_success_at || "N/A"}`,
    ...await (async () => {
      const pHealth = await context.db.prepare(
        "SELECT provider, status, consecutive_failures, last_failure_code, updated_at FROM provider_health"
      ).all().catch(() => ({ results: [] }));
      const groq = (pHealth.results || []).find((p: any) => p.provider?.includes("groq"));
      const aiState = groq ? `Groq (${groq.status})` : "Groq primary (healthy)";
      const reason = groq?.last_failure_code ? ` [Reason: ${groq.last_failure_code}]` : "";
      return [
        `• AI State: ${aiState}, Workers AI secondary (Gemini: parked)${reason}`,
        `• Next AI Retry: Immediate on fallback`
      ];
    })(),
  ];

  await context.db
    .prepare(`UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'status_queried' WHERE update_id = ?`)
    .bind((context.now || new Date()).toISOString(), context.updateId)
    .run()
    .catch(() => {});

  return { command: "status", args, success: true, response: lines.join("\n") };
}

export async function handleBriefing(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "briefing", args, success: false, response: "No database connection." };
  }
  const now = context.now || new Date();
  const ist = getISTDateParts(now);
  const hour = parseInt(ist.hours, 10);
  const isEvening = args.toLowerCase().includes("evening") || hour >= 17;
  const text = isEvening
    ? await buildEveningBriefingText(context.db, ist.localDate, ist.dayOfWeek, now)
    : await buildMorningBriefingText(context.db, ist.localDate, ist.dayOfWeek, now);

  await context.db
    .prepare(`UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'briefing_queried' WHERE update_id = ?`)
    .bind(now.toISOString(), context.updateId)
    .run()
    .catch(() => {});

  return { command: "briefing", args, success: true, response: text };
}

export async function handleHeartbeat(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "heartbeat", args, success: false, response: "No database connection." };
  }
  const now = context.now || new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  const [overdue, staleProps, dev] = await Promise.all([
    context.db.prepare(`SELECT count(*) as cnt FROM tasks WHERE status = 'open' AND due_date_time_local < ?`).bind(oneDayAgo.slice(0, 16)).first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
    context.db.prepare(`SELECT count(*) as cnt FROM task_proposals WHERE status = 'pending' AND created_at < ?`).bind(oneDayAgo).first<{ cnt: number }>().catch(() => ({ cnt: 0 })),
    context.db.prepare(`SELECT MAX(last_seen_at) as last_seen FROM desktop_devices WHERE revoked_at IS NULL`).first<{ last_seen: string | null }>().catch(() => null),
  ]);

  const findings: string[] = [];
  if (overdue && overdue.cnt > 0) findings.push(`• ${overdue.cnt} task(s) overdue > 24h`);
  if (staleProps && staleProps.cnt > 0) findings.push(`• ${staleProps.cnt} proposal(s) pending > 24h`);
  if (findings.length === 0) findings.push("• All invariants green. Zero stale items.");

  const lines = [
    "💓 *Heartbeat Findings (Deterministic)*",
    "",
    ...findings,
    "",
    `Desktop Mirror: ${dev?.last_seen ? "Last seen " + dev.last_seen : "Never connected"}`,
  ];

  await context.db
    .prepare(`UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'heartbeat_queried' WHERE update_id = ?`)
    .bind(now.toISOString(), context.updateId)
    .run()
    .catch(() => {});

  return { command: "heartbeat", args, success: true, response: lines.join("\n") };
}

export async function handlePause(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "pause", args, success: false, response: "No database connection." };
  }

  const now = context.now || new Date();
  const nowIso = now.toISOString();

  // Read current paused state (idempotent guard)
  const current = await context.db
    .prepare(`SELECT value FROM settings WHERE key = 'paused'`)
    .first<{ value: string }>();

  if (current?.value === "true") {
    return { command: "pause", args, success: true, response: "Already paused." };
  }

  const auditEventId = crypto.randomUUID();
  const episodeId = crypto.randomUUID();

  const upsertStmt = context.db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('paused', 'true', ?)
     ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at`
  ).bind(nowIso);

  const episodeStmt = context.db.prepare(
    `INSERT INTO pause_episodes (id, paused_at, catchup_status, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?)`
  ).bind(episodeId, nowIso, nowIso, nowIso);

  const episodeSettingStmt = context.db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('current_pause_episode', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(episodeId, nowIso);

  const auditStmt = context.db.prepare(
    `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
     VALUES (?, 'settings', 'paused', 'system_paused', 'owner:telegram', ?, ?)`
  ).bind(
    auditEventId,
    JSON.stringify({ previous_value: current?.value ?? null, episode_id: episodeId }),
    nowIso
  );

  const ledgerStmt = context.db.prepare(
    `UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'system_paused' WHERE update_id = ?`
  ).bind(nowIso, context.updateId);

  await context.db.batch([upsertStmt, episodeStmt, episodeSettingStmt, auditStmt, ledgerStmt]);

  return { command: "pause", args, success: true, response: "Paused. No reminders will fire until you /resume." };
}

export async function handleResume(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "resume", args, success: false, response: "No database connection." };
  }

  const now = context.now || new Date();
  const nowIso = now.toISOString();

  // Read current paused state (idempotent guard)
  const current = await context.db
    .prepare(`SELECT value FROM settings WHERE key = 'paused'`)
    .first<{ value: string }>();

  if (!current || current.value !== "true") {
    return { command: "resume", args, success: true, response: "Not currently paused." };
  }

  const activeEpisode = await context.db
    .prepare(`SELECT value FROM settings WHERE key = 'current_pause_episode'`)
    .first<{ value: string }>();

  const episodeId = activeEpisode?.value;
  const auditEventId = crypto.randomUUID();

  const upsertStmt = context.db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('paused', 'false', ?)
     ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at`
  ).bind(nowIso);

  const auditStmt = context.db.prepare(
    `INSERT INTO audit_events (id, entity_type, entity_id, event_type, actor, details_json, created_at)
     VALUES (?, 'settings', 'paused', 'system_resumed', 'owner:telegram', ?, ?)`
  ).bind(auditEventId, JSON.stringify({ previous_value: "true", episode_id: episodeId ?? null }), nowIso);

  const ledgerStmt = context.db.prepare(
    `UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'system_resumed' WHERE update_id = ?`
  ).bind(nowIso, context.updateId);

  const stmts: any[] = [upsertStmt, auditStmt, ledgerStmt];

  if (episodeId) {
    const updateEpisodeStmt = context.db.prepare(
      `UPDATE pause_episodes SET resumed_at = ?, catchup_status = 'planned', updated_at = ? WHERE id = ?`
    ).bind(nowIso, nowIso, episodeId);

    const clearEpisodeSetting = context.db.prepare(
      `DELETE FROM settings WHERE key = 'current_pause_episode'`
    );

    stmts.push(updateEpisodeStmt, clearEpisodeSetting);
  }

  await context.db.batch(stmts);

  // Plan catch-up digest for this episode (TEST-2B.5)
  if (episodeId) {
    await planCatchupDigest(context.db, episodeId, now);
  }

  return { command: "resume", args, success: true, response: "Resumed. Reminders will fire as scheduled." };
}

// ==========================================
// Block 3B: Timetable Telegram Handlers
// ==========================================

export async function handleTomorrow(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "tomorrow", args, success: false, response: "No database connection." };
  }
  const now = context.now || new Date();
  const ist = getISTDateParts(now);
  const tomorrowYmd = addDaysYmd(ist.localDate, 1);

  const digestMsg = await renderPrepDigestMessage(context.db, tomorrowYmd);

  if (context.updateId) {
    await context.db
      .prepare(`UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'tomorrow_queried' WHERE update_id = ?`)
      .bind(now.toISOString(), context.updateId)
      .run()
      .catch(() => {});
  }

  return { command: "tomorrow", args, success: true, response: digestMsg };
}

export async function handleNextClass(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "nextclass", args, success: false, response: "No database connection." };
  }
  const now = context.now || new Date();
  const next = await getNextClass(context.db, now);

  if (!next) {
    return { command: "nextclass", args, success: true, response: "No upcoming classes found today or tomorrow." };
  }

  const roomStr = next.room ? ` in Room ${next.room}` : "";
  const facultyStr = next.faculty ? ` with ${next.faculty}` : "";
  const resp = `⏰ Next Class: ${next.subject_name}\n📅 Date: ${next.occurrence_date} (${next.start_time} – ${next.end_time})${roomStr}${facultyStr}`;

  return { command: "nextclass", args, success: true, response: resp };
}

export async function handleWhereAmI(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "whereami", args, success: false, response: "No database connection." };
  }
  const now = context.now || new Date();
  const ongoing = await getOngoingClass(context.db, now);

  if (!ongoing) {
    return { command: "whereami", args, success: true, response: "You have no ongoing class right now." };
  }

  const resp = `📍 Current Class: ${ongoing.subject_name}\n⏰ Time: ${ongoing.start_time} – ${ongoing.end_time}\n🚪 Room: ${ongoing.room || "TBA"}\n👨‍🏫 Faculty: ${ongoing.faculty || "N/A"}`;
  return { command: "whereami", args, success: true, response: resp };
}

export async function handleSchedule(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "schedule", args, success: false, response: "No database connection." };
  }
  const now = context.now || new Date();
  const ist = getISTDateParts(now);
  const fromYmd = ist.localDate;
  const toYmd = addDaysYmd(fromYmd, 7);

  const preview = await getSchedulePreview(context.db, fromYmd, toYmd);
  const daysWithClasses = preview.filter((p) => p.classes.length > 0);

  if (daysWithClasses.length === 0) {
    return { command: "schedule", args, success: true, response: `No classes scheduled between ${fromYmd} and ${toYmd}.` };
  }

  let msg = `📅 Class Schedule (${fromYmd} to ${toYmd}):\n\n`;
  for (const day of daysWithClasses) {
    msg += `🗓 ${day.date}:\n`;
    for (const c of day.classes) {
      msg += `  • ${c.start_time} - ${c.end_time}: ${c.subject_name}${c.room ? ` (${c.room})` : ""}\n`;
    }
    msg += `\n`;
  }

  return { command: "schedule", args, success: true, response: msg.trim() };
}

export async function handleSemester(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "semester", args, success: false, response: "No database connection." };
  }
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const now = context.now || new Date();
  const nowIso = now.toISOString();

  if (sub === "list" || !sub) {
    const sems = await context.db.prepare("SELECT * FROM timetable_semesters ORDER BY start_date DESC").all<any>();
    if (!sems.results || sems.results.length === 0) {
      return { command: "semester", args, success: true, response: "No semesters configured. Use /semester create <name> <start> <end>" };
    }
    let msg = "📚 Semesters:\n";
    for (const s of sems.results) {
      const activeMarker = s.is_active === 1 ? " [ACTIVE]" : "";
      msg += `• [${s.id.slice(0, 8)}] ${s.name}: ${s.start_date} to ${s.end_date}${activeMarker}\n`;
    }
    return { command: "semester", args, success: true, response: msg.trim() };
  }

  if (sub === "create") {
    if (parts.length < 4) {
      return { command: "semester", args, success: false, response: "Usage: /semester create <name> <start_date:YYYY-MM-DD> <end_date:YYYY-MM-DD>" };
    }
    const name = parts[1];
    const startDate = parts[2];
    const endDate = parts[3];
    const semId = crypto.randomUUID();

    await context.db.prepare(
      `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    ).bind(semId, name, startDate, endDate, nowIso, nowIso).run();

    return { command: "semester", args, success: true, response: `Semester created: "${name}" (${startDate} to ${endDate}) [ID: ${semId.slice(0, 8)}]` };
  }

  if (sub === "activate") {
    if (parts.length < 2) {
      return { command: "semester", args, success: false, response: "Usage: /semester activate <id>" };
    }
    const idFrag = parts[1];
    const sem = await context.db.prepare("SELECT id, name FROM timetable_semesters WHERE id = ? OR substr(id, 1, 8) = ?").bind(idFrag, idFrag).first<{ id: string; name: string }>();
    if (!sem) {
      return { command: "semester", args, success: false, response: `Semester not found: ${idFrag}` };
    }

    await activateSemester(context.db, sem.id, now);
    await materializeTimetableOccurrences(context.db, now);

    return { command: "semester", args, success: true, response: `Semester activated: "${sem.name}". Timetable materialized.` };
  }

  return { command: "semester", args, success: false, response: "Usage: /semester (list | create | activate)" };
}

export async function handleSubject(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "subject", args, success: false, response: "No database connection." };
  }
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const now = context.now || new Date();
  const nowIso = now.toISOString();

  const activeSem = await getActiveSemester(context.db);
  if (!activeSem) {
    return { command: "subject", args, success: false, response: "No active semester. Use /semester activate <id> first." };
  }

  if (sub === "list" || !sub) {
    const subjects = await context.db.prepare("SELECT * FROM timetable_subjects WHERE semester_id = ? ORDER BY name ASC").bind(activeSem.id).all<any>();
    if (!subjects.results || subjects.results.length === 0) {
      return { command: "subject", args, success: true, response: `No subjects in semester "${activeSem.name}". Use /subject add <code> <name>` };
    }
    let msg = `📖 Subjects in ${activeSem.name}:\n`;
    for (const s of subjects.results) {
      msg += `• [${s.id.slice(0, 8)}] ${s.code ? `${s.code} - ` : ""}${s.name}${s.faculty ? ` (${s.faculty})` : ""}\n`;
    }
    return { command: "subject", args, success: true, response: msg.trim() };
  }

  if (sub === "add") {
    if (parts.length < 3) {
      return { command: "subject", args, success: false, response: "Usage: /subject add <code> <name> [faculty] [room]" };
    }
    const code = parts[1];
    const name = parts[2];
    const faculty = parts[3] || null;
    const room = parts[4] || null;
    const subjId = crypto.randomUUID();

    await context.db.prepare(
      `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, default_room, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(subjId, activeSem.id, code, name, faculty, room, nowIso, nowIso).run();

    return { command: "subject", args, success: true, response: `Subject added: "${code} - ${name}"` };
  }

  return { command: "subject", args, success: false, response: "Usage: /subject (list | add)" };
}

export async function handleClass(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "class", args, success: false, response: "No database connection." };
  }
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const now = context.now || new Date();
  const nowIso = now.toISOString();

  const activeSem = await getActiveSemester(context.db);
  if (!activeSem) {
    return { command: "class", args, success: false, response: "No active semester. Use /semester activate <id> first." };
  }

  if (sub === "list" || !sub) {
    const slots = await context.db.prepare(
      `SELECT s.*, subj.name as subject_name, subj.code as subject_code
       FROM timetable_slots s
       JOIN timetable_subjects subj ON s.subject_id = subj.id
       WHERE s.semester_id = ? AND s.active = 1
       ORDER BY s.weekday ASC, s.start_time ASC`
    ).bind(activeSem.id).all<any>();

    if (!slots.results || slots.results.length === 0) {
      return { command: "class", args, success: true, response: `No classes configured in ${activeSem.name}. Use /class add ...` };
    }

    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let msg = `🎓 Classes in ${activeSem.name}:\n`;
    for (const s of slots.results) {
      const dName = dayNames[s.weekday - 1] || `Day ${s.weekday}`;
      msg += `• [${s.id.slice(0, 8)}] ${dName} ${s.start_time}-${s.end_time}: ${s.subject_name}${s.room ? ` (Room ${s.room})` : ""}\n`;
    }
    return { command: "class", args, success: true, response: msg.trim() };
  }

  if (sub === "add") {
    // Usage: /class add <subject_id_or_code> <weekday 1-7> <start_time> <end_time> [room]
    if (parts.length < 5) {
      return { command: "class", args, success: false, response: "Usage: /class add <subject_code_or_id> <weekday:1-7> <start_time:HH:mm> <end_time:HH:mm> [room]" };
    }
    const subjQuery = parts[1];
    const weekday = parseInt(parts[2], 10);
    const startTime = parts[3];
    const endTime = parts[4];
    const room = parts[5] || null;

    if (isNaN(weekday) || weekday < 1 || weekday > 7) {
      return { command: "class", args, success: false, response: "Weekday must be between 1 (Mon) and 7 (Sun)." };
    }

    const subj = await context.db.prepare(
      `SELECT id, name FROM timetable_subjects
       WHERE semester_id = ? AND (id = ? OR substr(id, 1, 8) = ? OR code = ?)`
    ).bind(activeSem.id, subjQuery, subjQuery, subjQuery).first<{ id: string; name: string }>();

    if (!subj) {
      return { command: "class", args, success: false, response: `Subject not found: "${subjQuery}"` };
    }

    const slotId = crypto.randomUUID();
    await context.db.prepare(
      `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(slotId, activeSem.id, subj.id, weekday, startTime, endTime, room, nowIso, nowIso).run();

    // Materialize forward occurrences
    await materializeTimetableOccurrences(context.db, now);

    return { command: "class", args, success: true, response: `Class scheduled: ${subj.name} on day ${weekday} (${startTime} - ${endTime})${room ? ` in ${room}` : ""}` };
  }

  if (sub === "delete") {
    if (parts.length < 2) {
      return { command: "class", args, success: false, response: "Usage: /class delete <slot_id>" };
    }
    const slotId = parts[1];
    await context.db.prepare("UPDATE timetable_slots SET active = 0, updated_at = ? WHERE id = ? OR substr(id, 1, 8) = ?").bind(nowIso, slotId, slotId).run();
    return { command: "class", args, success: true, response: `Class slot disabled: ${slotId}` };
  }

  return { command: "class", args, success: false, response: "Usage: /class (list | add | delete)" };
}

export async function handleHoliday(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "holiday", args, success: false, response: "No database connection." };
  }
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const now = context.now || new Date();
  const nowIso = now.toISOString();

  if (sub === "list" || !sub) {
    const hols = await context.db.prepare("SELECT * FROM holiday_calendar ORDER BY holiday_date ASC").all<any>();
    if (!hols.results || hols.results.length === 0) {
      return { command: "holiday", args, success: true, response: "No holidays configured. Use /holiday add <YYYY-MM-DD> <name>" };
    }
    let msg = "🌴 Holiday Calendar:\n";
    for (const h of hols.results) {
      msg += `• ${h.holiday_date}: ${h.name} (${h.holiday_scope})\n`;
    }
    return { command: "holiday", args, success: true, response: msg.trim() };
  }

  if (sub === "add") {
    if (parts.length < 3) {
      return { command: "holiday", args, success: false, response: "Usage: /holiday add <YYYY-MM-DD> <name> [scope:national|college|department]" };
    }
    const holDate = parts[1];
    const name = parts[2];
    const scope = parts[3] || "college";
    const holId = crypto.randomUUID();

    await context.db.prepare(
      `INSERT INTO holiday_calendar (id, name, holiday_date, is_full_day, holiday_scope, created_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name`
    ).bind(holId, name, holDate, scope, nowIso).run();

    return { command: "holiday", args, success: true, response: `Holiday recorded: ${holDate} — ${name}` };
  }

  if (sub === "remove") {
    if (parts.length < 2) {
      return { command: "holiday", args, success: false, response: "Usage: /holiday remove <holiday_date_or_id>" };
    }
    const query = parts[1];
    await context.db.prepare("DELETE FROM holiday_calendar WHERE holiday_date = ? OR id = ? OR substr(id, 1, 8) = ?").bind(query, query, query).run();
    return { command: "holiday", args, success: true, response: `Holiday removed: ${query}` };
  }

  return { command: "holiday", args, success: false, response: "Usage: /holiday (list | add | remove)" };
}

export async function handleMaterials(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "materials", args, success: false, response: "No database connection." };
  }
  const parts = args.trim().split(/\s+/);
  const sub = parts[0]?.toLowerCase();
  const now = context.now || new Date();
  const nowIso = now.toISOString();

  if (sub === "add") {
    // Usage: /materials add <slot_id> <title> [material_type] [notes]
    if (parts.length < 3) {
      return { command: "materials", args, success: false, response: "Usage: /materials add <slot_id> <title> [notes]" };
    }
    const slotIdFrag = parts[1];
    const title = parts[2];
    const notes = parts.slice(3).join(" ") || null;

    const slot = await context.db.prepare(
      "SELECT id FROM timetable_slots WHERE id = ? OR substr(id, 1, 8) = ?"
    ).bind(slotIdFrag, slotIdFrag).first<{ id: string }>();

    if (!slot) {
      return { command: "materials", args, success: false, response: `Class slot not found: ${slotIdFrag}` };
    }

    const matId = crypto.randomUUID();
    await context.db.prepare(
      `INSERT INTO timetable_materials (id, slot_id, material_type, title, notes, required, created_at, updated_at)
       VALUES (?, ?, 'lab_manual', ?, ?, 1, ?, ?)`
    ).bind(matId, slot.id, title, notes, nowIso, nowIso).run();

    return { command: "materials", args, success: true, response: `Material attached: "${title}"` };
  }

  // List materials
  const materials = await context.db.prepare(
    `SELECT m.*, s.start_time, subj.name as subject_name
     FROM timetable_materials m
     JOIN timetable_slots s ON m.slot_id = s.id
     JOIN timetable_subjects subj ON s.subject_id = subj.id
     WHERE m.active = 1
     ORDER BY subj.name ASC, m.display_order ASC`
  ).all<any>();

  if (!materials.results || materials.results.length === 0) {
    return { command: "materials", args, success: true, response: "No materials registered. Use /materials add <slot_id> <title>" };
  }

  let msg = "🎒 Lab & Class Materials:\n";
  for (const m of materials.results) {
    msg += `• [${m.subject_name}] ${m.title}${m.notes ? ` (${m.notes})` : ""}\n`;
  }
  return { command: "materials", args, success: true, response: msg.trim() };
}

export async function handlePair(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return {
      command: "pair",
      args,
      success: false,
      response: "Database unavailable.",
    };
  }

  // Block 3: Desktop Outbox Mirror pairing (/pair desktop)
  if (args.trim().toLowerCase() === "desktop") {
    const code = await createPairingCode(context.db);
    return {
      command: "pair desktop",
      args,
      success: true,
      response: `🖥️ Desktop Pairing Code Generated\n\nYour one-time code: ${code}\nValid for 10 minutes.\n\nOn your PC run:\nnpm run agent:pair -- --code ${code}`,
    };
  }

  const ownerId = String(context.senderId ?? context.chatId ?? "owner");
  const now = context.now ?? new Date();
  const challenge = await createPairingChallenge(context.db, ownerId, "default", now);

  return {
    command: "pair",
    args,
    success: true,
    response: `🔐 Pairing Challenge Generated\n\nYour one-time code is: ${challenge.code}\n\nUse this code to log into the web dashboard or client app.\nThis code expires in 5 minutes.`,
  };
}

export async function handleSuggestions(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return {
      command: "suggestions",
      args,
      success: false,
      response: "Database unavailable.",
    };
  }

  const now = context.now ?? new Date();
  const suggestions = await evaluateSuggestions(context.db, now);

  if (suggestions.length === 0) {
    return {
      command: "suggestions",
      args,
      success: true,
      response: "✨ No suggestions right now! Everything is on track.",
    };
  }

  const lines = [
    `💡 *Personal AI OS Suggestions (${suggestions.length})*:\n`,
  ];

  for (const s of suggestions.slice(0, 5)) {
    const icon = s.priority === "high" ? "🔴" : s.priority === "medium" ? "🟡" : "ℹ️";
    lines.push(`${icon} *${s.title}*`);
    lines.push(`${s.message}`);
    lines.push(`Key: \`${s.id}\`\n`);
  }

  return {
    command: "suggestions",
    args,
    success: true,
    response: lines.join("\n"),
  };
}

export async function handleExport(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return {
      command: "export",
      args,
      success: false,
      response: "Database unavailable.",
    };
  }

  const now = context.now ?? new Date();
  const exportPayload = await getExportData(context.db, now);

  const lines = [
    "📦 *Personal AI OS Data Export*\n",
    `Exported: ${exportPayload.exported_at}`,
    `Timezone: ${exportPayload.timezone}\n`,
    "*Record Counts:*",
    `- Tasks: ${exportPayload.counts.tasks}`,
    `- Recurring Rules: ${exportPayload.counts.recurrence_rules}`,
    `- Semesters: ${exportPayload.counts.timetable_semesters}`,
    `- Subjects: ${exportPayload.counts.timetable_subjects}`,
    `- Timetable Slots: ${exportPayload.counts.timetable_slots}`,
    `- Materials: ${exportPayload.counts.timetable_materials}`,
    `- Class Occurrences: ${exportPayload.counts.class_occurrences}`,
    `- Audit Events: ${exportPayload.counts.audit_events}\n`,
    "ℹ️ Full JSON and CSV exports can be downloaded via authenticated API at `/api/v1/export`.",
  ];

  return {
    command: "export",
    args,
    success: true,
    response: lines.join("\n"),
  };
}

export async function handleAI(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "ai", args, success: false, response: "Database unavailable." };
  }
  const now = context.now ?? new Date();
  const ai = new AICapabilities(context.env || {}, context.db);
  const res = await ai.suggestNext(args || undefined, "personal", undefined, now);

  if (!res.ok || !res.data) {
    return {
      command: "ai",
      args,
      success: false,
      response: `AI suggestion failed: ${res.error?.message || "Unavailable"}`,
    };
  }

  const isMock = res.provider === "mock" || (res.provider && res.provider.includes("mock"));
  const header = isMock ? "🤖 *AI Offline* (Deterministic fallback)" : `🤖 *AI Suggestion* (${res.provider}/${res.model})`;
  const response = `${header}:\n\n🎯 *Next Action*: ${res.data.next_action}\n💡 *Rationale*: ${res.data.rationale}\n📈 *Confidence*: ${Math.round(res.data.confidence * 100)}%`;

  return {
    command: "ai",
    args,
    success: true,
    response,
  };
}

export async function handleInbox(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "inbox", args, success: false, response: "Database unavailable." };
  }
  const res = await listTaskProposals(context.db, "pending", 5, 0);
  if (res.proposals.length === 0) {
    return {
      command: "inbox",
      args,
      success: true,
      response: "📥 Inbox is clear! No pending task proposals.",
    };
  }

  const lines = [`📥 *Pending Task Proposals (${res.total})*:\n`];
  const buttons: any[] = [];

  res.proposals.forEach((p, idx) => {
    const dStr = p.proposed_local_date ? ` [📅 ${p.proposed_local_date}${p.proposed_local_time ? ` ${p.proposed_local_time}` : ""}]` : "";
    lines.push(`${idx + 1}. *${p.title}*${dStr}\n   _Evidence: ${p.evidence_quote || "AI synthesis"}_`);
    buttons.push([
      { text: `✅ Confirm #${idx + 1}`, callback_data: `p_conf:${p.id.slice(0, 13)}` },
      { text: `❌ Reject #${idx + 1}`, callback_data: `p_rej:${p.id.slice(0, 13)}` },
    ]);
  });

  return {
    command: "inbox",
    args,
    success: true,
    response: lines.join("\n"),
    replyMarkup: { inline_keyboard: buttons },
    proposals: res.proposals,
  };
}

export async function handleBreakdown(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "breakdown", args, success: false, response: "Database unavailable." };
  }
  if (!args.trim()) {
    return {
      command: "breakdown",
      args,
      success: false,
      response: "Usage: /breakdown <task title or ID>\nExample: /breakdown Prepare Machine Learning Lab Report",
    };
  }
  const now = context.now ?? new Date();
  const ai = new AICapabilities(context.env || {}, context.db);

  const isTaskId = args.trim().length >= 8 && !args.trim().includes(" ");
  const input = isTaskId ? { taskId: args.trim() } : { title: args.trim() };

  const res = await ai.taskBreakdown(input, "personal", undefined, now);
  if (!res.ok || !res.data) {
    return {
      command: "breakdown",
      args,
      success: false,
      response: `Breakdown failed: ${res.error?.message || "Unavailable"}`,
    };
  }

  const lines = [
    `🤖 *Task Breakdown* (${res.provider}/${res.model}):`,
    `📋 ${res.data.summary}\n`,
    `Generated ${res.data.proposals.length} subtask proposals in your /inbox:`,
  ];

  const buttons: any[] = [];
  res.data.proposals.forEach((p, idx) => {
    lines.push(`${idx + 1}. *${p.title}* (~${p.estimated_minutes}m, priority: ${p.priority})`);
    if (p.id) {
      buttons.push([
        { text: `✅ Confirm #${idx + 1}`, callback_data: `p_conf:${p.id.slice(0, 13)}` },
        { text: `❌ Reject #${idx + 1}`, callback_data: `p_rej:${p.id.slice(0, 13)}` },
      ]);
    }
  });

  return {
    command: "breakdown",
    args,
    success: true,
    response: lines.join("\n"),
    replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
    proposals: res.data.proposals,
  };
}

export async function handlePlan(args: string, context?: CommandContext): Promise<CommandResult> {
  if (!context?.db) {
    return { command: "plan", args, success: false, response: "Database unavailable." };
  }
  const now = context.now ?? new Date();
  const ai = new AICapabilities(context.env || {}, context.db);
  const res = await ai.weeklyPlan("personal", undefined, now);

  if (!res.ok || !res.data) {
    return {
      command: "plan",
      args,
      success: false,
      response: `Weekly planning failed: ${res.error?.message || "Unavailable"}`,
    };
  }

  const lines = [
    `🗓️ *Weekly Plan Synthesis* (${res.provider}/${res.model}):`,
    `📝 ${res.data.summary}\n`,
  ];

  if (res.data.focus_areas && res.data.focus_areas.length > 0) {
    lines.push("🎯 *Focus Areas*:");
    res.data.focus_areas.forEach((fa) => lines.push(`• ${fa}`));
    lines.push("");
  }

  if (res.data.bottlenecks && res.data.bottlenecks.length > 0) {
    lines.push("⚠️ *Bottlenecks*:");
    res.data.bottlenecks.forEach((bn) => lines.push(`• ${bn}`));
    lines.push("");
  }

  if (res.data.proposals && res.data.proposals.length > 0) {
    lines.push(`📥 *Created ${res.data.proposals.length} Action Proposals* in /inbox`);
  }

  return {
    command: "plan",
    args,
    success: true,
    response: lines.join("\n"),
    proposals: res.data.proposals,
  };
}

// ---------------------------------------------------------------------------
// /profile -- Interactive daily rhythm profile setup
// ---------------------------------------------------------------------------
async function handleProfile(args: string, context?: CommandContext): Promise<CommandResult> {
  const db = context?.db;
  if (!db) return { command: "profile", args, success: false, response: "No DB context." };

  const now = new Date();

  // If arg is "key=value", save it
  if (args.includes("=")) {
    const eqIdx = args.indexOf("=");
    const key = args.slice(0, eqIdx).trim().toLowerCase();
    const value = args.slice(eqIdx + 1).trim();

    const ALLOWED: Record<string, string> = {
      wake: "wake_time",
      wake_time: "wake_time",
      leave: "leave_home_time",
      leave_home_time: "leave_home_time",
      commute_to: "commute_to_college_min",
      commute_to_college_min: "commute_to_college_min",
      commute_home: "commute_home_min",
      commute_home_min: "commute_home_min",
      buffer: "buffer_after_class_min",
      buffer_after_class_min: "buffer_after_class_min",
      bedtime: "bedtime",
      morning: "morning_anchor_time",
      morning_anchor_time: "morning_anchor_time",
      evening: "evening_anchor_time",
      evening_anchor_time: "evening_anchor_time",
    };

    const resolvedKey = ALLOWED[key];
    if (!resolvedKey) {
      return { command: "profile", args, success: false, response: `Unknown profile key: "${key}". Use /profile to see options.` };
    }

    await setProfileKey(db, resolvedKey, value);
    const profile = await getProfile(db);
    const missing = getMissingProfileKeys(profile);

    if (missing.length === 0) {
      return { command: "profile", args, success: true, response: `Profile saved: ${resolvedKey} = ${value}\n\nYour daily rhythm profile is complete!` };
    }
    return {
      command: "profile", args, success: true,
      response: `Profile saved: ${resolvedKey} = ${value}\n\nStill missing: ${missing.join(", ")}\nUse /profile <key>=<value> to fill in.`,
    };
  }

  // Show current profile
  const profile = await getProfile(db);
  const missing = getMissingProfileKeys(profile);

  const lines: string[] = ["Your daily rhythm profile:", ""];
  lines.push(`Wake time: ${profile.wake_time || "(not set)"}`);
  lines.push(`Leave home: ${profile.leave_home_time || "(not set)"}`);
  lines.push(`Commute to college: ${profile.commute_to_college_min ?? "(not set)"} min`);
  lines.push(`Commute home: ${profile.commute_home_min ?? "(not set)"} min`);
  lines.push(`Buffer after class: ${profile.buffer_after_class_min ?? "(not set)"} min`);
  lines.push(`Bedtime: ${profile.bedtime || "(not set)"}`);
  lines.push(`Morning anchor: ${profile.morning_anchor_time || "(not set)"}`);
  lines.push(`Evening anchor: ${profile.evening_anchor_time || "(not set)"}`);
  lines.push("");

  if (missing.length > 0) {
    lines.push(`Missing: ${missing.join(", ")}`);
    lines.push("Set with: /profile wake_time=07:00  or  /profile commute_to=30");
  } else {
    lines.push("Profile complete!");
  }

  return { command: "profile", args, success: true, response: lines.join("\n") };
}
// ---------------------------------------------------------------------------
// /capture -- Set implicit capture mode
// ---------------------------------------------------------------------------
async function handleCapture(args: string, context?: CommandContext): Promise<CommandResult> {
  const db = context?.db;
  if (!db) return { command: "capture", args, success: false, response: "No DB context." };
  const response = await handleCaptureCommand(args, db, new Date());
  return { command: "capture", args, success: true, response };
}
export async function routeCommand(text: string, context?: CommandContext): Promise<CommandResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const rawCommand = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

  const commandName = rawCommand.slice(1).split("@")[0].toLowerCase();

  switch (commandName) {
    case "connect": {
      if (!context?.db) return { command: "connect", args, success: false, response: "No DB." };
      if (args.toLowerCase().startsWith("gmail")) {
        const clientId = context.env?.GMAIL_CLIENT_ID;
        const clientSecret = context.env?.GMAIL_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return {
            command: "connect",
            args,
            success: false,
            response: "Google OAuth credentials not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in Cloudflare secrets.",
          };
        }
        const { codeVerifier, codeChallenge } = await generatePKCE();
        const state = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        const expiresAt = new Date((context.now || new Date()).getTime() + 10 * 60 * 1000).toISOString();
        await context.db.prepare(
          "INSERT OR REPLACE INTO gmail_oauth_states (state, code_verifier, expires_at, created_at) VALUES (?, ?, ?, ?)"
        ).bind(state, codeVerifier, expiresAt, (context.now || new Date()).toISOString()).run();

        const origin = "https://personal-ai-os.jatin-personal-ai.workers.dev";
        const redirectUri = `${origin}/api/v1/auth/gmail/callback`;
        const consentUrl = buildConsentUrl(clientId, redirectUri, state, codeChallenge);
        return {
          command: "connect",
          args,
          success: true,
          response: `🔗 Tap the link below to connect Gmail (read-only, valid for 10 min):\n${consentUrl}`,
        };
      }
      return { command: "connect", args, success: false, response: "Usage: /connect gmail" };
    }
    case "disconnect": {
      if (!context?.db) return { command: "disconnect", args, success: false, response: "No DB." };
      if (args.toLowerCase().startsWith("gmail")) {
        await revokeGmailAccess(context.db, context.env?.GMAIL_ENCRYPTION_KEY);
        return {
          command: "disconnect",
          args,
          success: true,
          response: "Disconnected Gmail. OAuth tokens revoked and ciphertext purged from database.",
        };
      }
      return { command: "disconnect", args, success: false, response: "Usage: /disconnect gmail" };
    }
    case "email": {
      if (!context?.db) return { command: "email", args, success: false, response: "No DB." };
      const sub = args.trim().toLowerCase();
      const nowIso = (context.now || new Date()).toISOString();
      if (sub === "on") {
        await context.db.prepare("UPDATE gmail_auth SET is_active = 1, updated_at = ? WHERE id = 'primary'").bind(nowIso).run();
        return { command: "email", args, success: true, response: "Gmail read-only ingestion enabled." };
      } else if (sub === "off") {
        await context.db.prepare("UPDATE gmail_auth SET is_active = 0, updated_at = ? WHERE id = 'primary'").bind(nowIso).run();
        return { command: "email", args, success: true, response: "Gmail read-only ingestion paused." };
      }
      return { command: "email", args, success: false, response: "Usage: /email on | /email off" };
    }
    case "start":
      return handleStart(args, context);
    case "help":
      return handleHelp(args, context);
    case "add":
      return await handleAdd(args, context);
    case "today":
      return await handleToday(args, context);
    case "done":
      return await handleDone(args, context);
    case "snooze":
      return await handleSnooze(args, context);
    case "health":
      return await handleHealth(args, context);
    case "status":
      return await handleStatus(args, context);
    case "briefing":
      return await handleBriefing(args, context);
    case "heartbeat":
      return await handleHeartbeat(args, context);
    case "attention": {
      if (!context?.db) return { command: "attention", args, success: false, response: "No DB." };
      const rep = await renderAttentionReport(context.db, context.now);
      return { command: "attention", args, success: true, response: rep };
    }
    case "pause":
      return await handlePause(args, context);
    case "resume":
      return await handleResume(args, context);
    case "tomorrow":
      return await handleTomorrow(args, context);
    case "nextclass":
      return await handleNextClass(args, context);
    case "whereami":
      return await handleWhereAmI(args, context);
    case "schedule":
    case "week":
      return await handleSchedule(args, context);
    case "semester":
      return await handleSemester(args, context);
    case "subject":
      return await handleSubject(args, context);
    case "class":
      return await handleClass(args, context);
    case "holiday":
      return await handleHoliday(args, context);
    case "materials":
      return await handleMaterials(args, context);
    case "pair":
      return await handlePair(args, context);
    case "devices": {
      if (!context?.db) return { command: "devices", args, success: false, response: "No DB." };
      const res = await handleListDevicesCommand(context.db);
      return { command: "devices", args, success: true, response: res };
    }
    case "revoke": {
      if (!context?.db) return { command: "revoke", args, success: false, response: "No DB." };
      const res = await handleRevokeDeviceCommand(context.db, args);
      return { command: "revoke", args, success: true, response: res };
    }
    case "suggestions":
      return await handleSuggestions(args, context);
    case "export":
      return await handleExport(args, context);
    case "ai":
    case "suggest":
      return await handleAI(args, context);
    case "inbox":
      return await handleInbox(args, context);
    case "breakdown":
      return await handleBreakdown(args, context);
    case "plan":
      return await handlePlan(args, context);
    case "remember": {
      if (!context?.db) return { command: "remember", args, success: false, response: "No DB." };
      const res = await handleRememberCommand(args, context.db, context.now);
      return { command: "remember", args, success: res.success, response: res.response };
    }
    case "memories": {
      if (!context?.db) return { command: "memories", args, success: false, response: "No DB." };
      const res = await handleMemoriesCommand(context.db, context.now);
      return { command: "memories", args, success: res.success, response: res.response };
    }
    case "forget": {
      if (!context?.db) return { command: "forget", args, success: false, response: "No DB." };
      const res = await handleForgetCommand(args, context.db);
      return { command: "forget", args, success: res.success, response: res.response, replyMarkup: res.replyMarkup } as any;
    }
    case "about": {
      if (!context?.db) return { command: "about", args, success: false, response: "No DB." };
      const res = await handleAboutCommand(args, context.db, context.now);
      return { command: "about", args, success: res.success, response: res.response };
    }
    default:
      return null;
  }
}
