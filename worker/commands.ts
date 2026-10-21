import { parseDateShorthand, ParsedDeadline, getISTDateParts, istToUtcDate } from "./dateParser";
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
}

export interface CommandResult {
  command: string;
  args: string;
  response: string;
  success?: boolean;
  taskId?: string;
  deadline?: ParsedDeadline;
  tasks?: any[];
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

interface PersistTaskInput {
  title: string;
  deadline: ParsedDeadline;
  rawExcerpt: string;   // original user text (capped to 120 chars for excerpt)
  context: CommandContext;
  now: Date;
}

async function persistTask(input: PersistTaskInput): Promise<string> {
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
      response: "Usage: /add <title> or /add <date-shorthand> | <title>",
    };
  }

  let titlePart: string;
  let deadline: ParsedDeadline;

  if (trimmed.includes("|")) {
    const pipeIndex = trimmed.indexOf("|");
    const datePart = trimmed.slice(0, pipeIndex).trim();
    titlePart = trimmed.slice(pipeIndex + 1).trim();

    if (!titlePart) {
      return { command: "add", args, success: false, response: "Task title cannot be empty." };
    }

    const recResult = parseRecurrenceShorthand(datePart, context?.now);
    if (recResult.isRecurrence) {
      if (recResult.error || !recResult.ruleInput) {
        return { command: "add", args, success: false, response: recResult.error || "Invalid recurrence format." };
      }
      if (context?.db) {
        const { ruleId, occurrencesCreated } = await createRecurrenceRule(
          context.db,
          { ...recResult.ruleInput, title: titlePart },
          context.now || new Date()
        );
        const nowIso = (context.now || new Date()).toISOString();
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

    const parseResult = parseDateShorthand(datePart, context?.now);
    if (!parseResult.success || !parseResult.deadline) {
      return { command: "add", args, success: false, response: parseResult.error || "Invalid date format." };
    }
    deadline = parseResult.deadline;
  } else {
    titlePart = trimmed;
    deadline = { kind: "none", localDate: null, localTime: null, utcInstant: null };
  }

  let taskId = crypto.randomUUID();   // fallback if no DB
  if (context?.db) {
    taskId = await persistTask({
      title: titlePart,
      deadline,
      rawExcerpt: trimmed,
      context,
      now: context.now || new Date(),
    });
  }

  return {
    command: "add",
    args,
    success: true,
    taskId,
    deadline,
    response: `Task created: "${titlePart}"`,
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

  const [health, paused] = await Promise.all([
    context.db
      .prepare(`SELECT consecutive_failures, last_scheduler_success_at, last_telegram_delivery_at, updated_at FROM system_health WHERE id = 1`)
      .first<{
        consecutive_failures: number;
        last_scheduler_success_at: string | null;
        last_telegram_delivery_at: string | null;
        updated_at: string;
      }>(),
    context.db
      .prepare(`SELECT value FROM settings WHERE key = 'paused'`)
      .first<{ value: string }>(),
  ]);

  const isPaused = paused?.value === "true";
  const failures = health?.consecutive_failures ?? 0;
  const schedulerOk = failures === 0;

  const lines = [
    `Status: ${schedulerOk ? "ok" : "degraded"}`,
    `Paused: ${isPaused ? "yes" : "no"}`,
    `Consecutive failures: ${failures}`,
    health?.last_scheduler_success_at
      ? `Last scheduler run: ${health.last_scheduler_success_at}`
      : "Last scheduler run: never",
    health?.last_telegram_delivery_at
      ? `Last Telegram delivery: ${health.last_telegram_delivery_at}`
      : "Last Telegram delivery: never",
  ];

  await context.db
    .prepare(`UPDATE telegram_updates SET status = 'processed', processed_at = ?, outcome = 'health_queried' WHERE update_id = ?`)
    .bind((context.now || new Date()).toISOString(), context.updateId)
    .run();

  return { command: "health", args, success: true, response: lines.join("\n") };
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
    default:
      return null;
  }
}
