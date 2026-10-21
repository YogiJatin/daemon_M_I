import { routeCommand, handlePlainText } from "./commands";
import { sendTelegramMessage, answerCallbackQuery } from "./telegram";
import { runScheduler } from "./scheduler";
import {
  updateTaskTitle,
  updateTaskDeadline,
  planPrepDigest,
  planCatchupDigest,
  adjustForQuietHours,
  isQuietHours,
} from "./notificationPlanner";
import { handleCallbackQuery } from "./callbacks";
import {
  createRecurrenceRule,
  pauseRecurrenceRule,
  resumeRecurrenceRule,
  editRecurrenceSeries,
  materializeRecurringOccurrences,
  calculateNextOccurrenceDates,
  parseRecurrenceShorthand,
  RecurrenceRuleRow,
  addDaysYmd,
} from "./recurrenceEngine";
import {
  getActiveSemester,
  activateSemester,
  materializeTimetableOccurrences,
  getPrepDigestData,
  renderPrepDigestMessage,
  getClassesForDate,
  getNextClass,
  getOngoingClass,
  getSchedulePreview,
} from "./timetableEngine";
import { getISTDateParts, istToUtcDate } from "./dateParser";
import { authenticateRequest } from "./auth";
import { handleApiRequest, jsonError } from "./apiRouter";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // Block 4: UI Placeholders (strictly non-visual JSON status)
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/panel")) {
      return Response.json({
        status: "not_implemented_ui",
        backend_ready: true,
        api_version: "v1",
      });
    }

    // Block 0: Public health liveness
    if (request.method === "GET" && url.pathname === "/health/public") {
      return Response.json({ ok: true });
    }

    // Block 4: Public Pairing Challenge Exchange (unauthenticated)
    if (request.method === "POST" && url.pathname === "/api/v1/auth/pair") {
      return await handleApiRequest(request, env);
    }

    // Block 4: General Authentication Middleware for private /api/v1/* routes
    const isExempt =
      url.pathname === "/health/public" ||
      url.pathname === "/" ||
      url.pathname === "/panel" ||
      url.pathname === "/api/v1/auth/pair" ||
      url.pathname === "/api/v1/telegram/webhook" ||
      url.pathname === "/webhook" ||
      url.pathname.startsWith("/api/v1/internal/");

    if (!isExempt && url.pathname.startsWith("/api/v1/")) {
      const auth = await authenticateRequest(
        request,
        env.DB,
        env.TELEGRAM_OWNER_ID,
        new Date(),
        env.TELEGRAM_WEBHOOK_SECRET
      );

      if (!auth.authenticated) {
        return jsonError("unauthorized", "Authentication required to access this system service", 401);
      }

      // Check if handled by OS Services Router
      const res = await handleApiRequest(request, env, auth.session);
      if (res.status !== 404) {
        return res;
      }
    }

    // Block 2A & 2B: Manual/Test scheduler trigger (authenticated with webhook secret)
    if (request.method === "POST" && url.pathname === "/api/v1/internal/scheduler/run") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!secretHeader || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      let reqBody: any = {};
      try {
        reqBody = await request.json();
      } catch {
        // empty body is fine
      }

      const now = reqBody.now ? new Date(reqBody.now) : new Date();
      const batchSize = typeof reqBody.batchSize === "number" ? reqBody.batchSize : undefined;
      const botToken = reqBody.botToken !== undefined ? reqBody.botToken : env.TELEGRAM_BOT_TOKEN;
      const ownerChatId = reqBody.ownerChatId !== undefined ? reqBody.ownerChatId : env.TELEGRAM_OWNER_ID;
      const pingUrl = reqBody.pingUrl !== undefined ? reqBody.pingUrl : env.HEALTHCHECKS_PING_URL;
      const dailyCap = typeof reqBody.dailyCap === "number" ? reqBody.dailyCap : undefined;

      const result = await runScheduler(env.DB, now, batchSize, { botToken, ownerChatId, pingUrl, dailyCap });
      return Response.json({ ok: true, result });
    }

    // Block 2A: Test endpoint for task edits (TEST-2A.4 title-only vs deadline edits)
    if (request.method === "POST" && url.pathname === "/api/v1/internal/test/task-edit") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!secretHeader || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await request.json()) as any;
      if (body.action === "updateTitle") {
        await updateTaskTitle(env.DB, body.taskId, body.title, new Date());
      } else if (body.action === "updateDeadline") {
        await updateTaskDeadline(env.DB, body.taskId, body.deadline, new Date());
      }

      const task = await env.DB.prepare(
        "SELECT id, title, deadline_version, deadline_kind, deadline_at_utc FROM tasks WHERE id = ?"
      )
        .bind(body.taskId)
        .first();

      const notifs = await env.DB.prepare(
        "SELECT id, task_id, deadline_version, dedup_key, status, scheduled_at FROM notification_log WHERE task_id = ?"
      )
        .bind(body.taskId)
        .all();

      return Response.json({ ok: true, task, notifs: notifs.results });
    }

    // Block 2B: Test endpoints for quiet hours, prep digest & catchup digest
    if (request.method === "POST" && url.pathname === "/api/v1/internal/test/block2b") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!secretHeader || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await request.json()) as any;
      const now = body.now ? new Date(body.now) : new Date();

      if (body.action === "checkQuietHours") {
        const inQuiet = isQuietHours(new Date(body.timeUtc));
        const adjusted = adjustForQuietHours(body.timeUtc, now);
        return Response.json({ ok: true, inQuiet, adjusted });
      }

      if (body.action === "planPrepDigest") {
        const planned = await planPrepDigest(env.DB, body.istDate, now);
        const row = await env.DB.prepare("SELECT * FROM notification_log WHERE dedup_key = ?")
          .bind(`prep-digest:${body.istDate}`)
          .first();
        return Response.json({ ok: true, planned, row });
      }

      if (body.action === "planCatchupDigest") {
        const planned = await planCatchupDigest(env.DB, body.episodeId, now);
        const row = await env.DB.prepare("SELECT * FROM notification_log WHERE dedup_key = ?")
          .bind(`catchup:${body.episodeId}`)
          .first();
        return Response.json({ ok: true, planned, row });
      }

      return Response.json({ ok: false, error: "unknown_action" });
    }

    // ==========================================
    // Block 3A: Recurrence Rule REST Endpoints
    // ==========================================

    // GET /api/v1/recurrence-rules
    if (request.method === "GET" && url.pathname === "/api/v1/recurrence-rules") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const activeOnly = url.searchParams.get("active") === "1";
      const query = activeOnly
        ? "SELECT * FROM recurrence_rules WHERE active = 1 ORDER BY created_at DESC"
        : "SELECT * FROM recurrence_rules ORDER BY created_at DESC";

      const { results } = await env.DB.prepare(query).all<RecurrenceRuleRow>();
      return Response.json({ ok: true, rules: results || [] });
    }

    // POST /api/v1/recurrence-rules
    if (request.method === "POST" && url.pathname === "/api/v1/recurrence-rules") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await request.json()) as any;
      const now = body.now ? new Date(body.now) : new Date();

      if (!body.title || !body.pattern || !body.start_date) {
        return Response.json(
          { ok: false, error: "Missing required fields: title, pattern, start_date" },
          { status: 400 }
        );
      }

      const result = await createRecurrenceRule(env.DB, body, now);
      return Response.json({ ok: true, ...result });
    }

    // POST /api/v1/recurrence-rules/:id/pause
    const pauseMatch = url.pathname.match(/^\/api\/v1\/recurrence-rules\/([^/]+)\/pause$/);
    if (request.method === "POST" && pauseMatch) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const ruleId = pauseMatch[1];
      let body: any = {};
      try {
        body = await request.json();
      } catch {}
      const now = body.now ? new Date(body.now) : new Date();

      const result = await pauseRecurrenceRule(env.DB, ruleId, now);
      return Response.json({ ok: result.success, ...result });
    }

    // POST /api/v1/recurrence-rules/:id/resume
    const resumeMatch = url.pathname.match(/^\/api\/v1\/recurrence-rules\/([^/]+)\/resume$/);
    if (request.method === "POST" && resumeMatch) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const ruleId = resumeMatch[1];
      let body: any = {};
      try {
        body = await request.json();
      } catch {}
      const now = body.now ? new Date(body.now) : new Date();

      const result = await resumeRecurrenceRule(env.DB, ruleId, now);
      return Response.json({ ok: result.success, ...result });
    }

    // PATCH /api/v1/recurrence-rules/:id
    const editMatch = url.pathname.match(/^\/api\/v1\/recurrence-rules\/([^/]+)$/);
    if (request.method === "PATCH" && editMatch) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const ruleId = editMatch[1];
      const body = (await request.json()) as any;
      const now = body.now ? new Date(body.now) : new Date();

      const result = await editRecurrenceSeries(env.DB, ruleId, body, now);
      return Response.json({ ok: result.success, ...result });
    }

    // POST /api/v1/internal/test/recurrence — Canonical Acceptance Tests (TEST-3A.1 to TEST-3A.6)
    if (request.method === "POST" && url.pathname === "/api/v1/internal/test/recurrence") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await request.json()) as any;
      const action = body.action || "ALL";
      const now = body.now ? new Date(body.now) : new Date("2026-10-21T06:00:00.000Z"); // Wednesday in IST
      const testResults: Record<string, any> = {};

      // TEST-3A.1: daily, weekly and selected-weekday rules create expected IST local-date occurrences
      if (action === "TEST-3A.1" || action === "ALL") {
        // Daily rule
        const dailyDates = calculateNextOccurrenceDates(
          {
            pattern: "daily",
            interval: 1,
            weekdays_json: null,
            month_day: null,
            year_month: null,
            start_date: "2026-10-21",
            end_date: null,
            week_anchor_monday: null,
          },
          "2026-10-21",
          "2026-10-25"
        );
        const dailyExpected = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
        const dailyPass = JSON.stringify(dailyDates) === JSON.stringify(dailyExpected);

        // Weekly rule (every Friday = 5)
        const weeklyDates = calculateNextOccurrenceDates(
          {
            pattern: "weekly",
            interval: 1,
            weekdays_json: JSON.stringify([5]),
            month_day: null,
            year_month: null,
            start_date: "2026-10-21",
            end_date: null,
            week_anchor_monday: null,
          },
          "2026-10-21",
          "2026-11-06"
        );
        const weeklyExpected = ["2026-10-23", "2026-10-30", "2026-11-06"];
        const weeklyPass = JSON.stringify(weeklyDates) === JSON.stringify(weeklyExpected);

        // Selected weekdays rule (Mon=1, Wed=3, Fri=5)
        const selectedDates = calculateNextOccurrenceDates(
          {
            pattern: "selected_weekdays",
            interval: 1,
            weekdays_json: JSON.stringify([1, 3, 5]),
            month_day: null,
            year_month: null,
            start_date: "2026-10-21",
            end_date: null,
            week_anchor_monday: null,
          },
          "2026-10-21",
          "2026-10-28"
        );
        const selectedExpected = ["2026-10-21", "2026-10-23", "2026-10-26", "2026-10-28"];
        const selectedPass = JSON.stringify(selectedDates) === JSON.stringify(selectedExpected);

        testResults["TEST-3A.1"] = {
          passed: dailyPass && weeklyPass && selectedPass,
          daily: { passed: dailyPass, generated: dailyDates, expected: dailyExpected },
          weekly: { passed: weeklyPass, generated: weeklyDates, expected: weeklyExpected },
          selected_weekdays: { passed: selectedPass, generated: selectedDates, expected: selectedExpected },
        };
      }

      // TEST-3A.2: alternating A/B rules produce the expected sequence from explicit anchor Monday
      if (action === "TEST-3A.2" || action === "ALL") {
        const anchorMonday = "2026-10-19"; // Week A Monday

        const altADates = calculateNextOccurrenceDates(
          {
            pattern: "alternate_week_a",
            interval: 1,
            weekdays_json: JSON.stringify([1]), // Mondays
            month_day: null,
            year_month: null,
            start_date: "2026-10-19",
            end_date: null,
            week_anchor_monday: anchorMonday,
          },
          "2026-10-19",
          "2026-11-10"
        );
        // Expect: 2026-10-19 (Week A), skip 2026-10-26 (Week B), 2026-11-02 (Week A), skip 2026-11-09 (Week B)
        const altAExpected = ["2026-10-19", "2026-11-02"];
        const altAPass = JSON.stringify(altADates) === JSON.stringify(altAExpected);

        const altBDates = calculateNextOccurrenceDates(
          {
            pattern: "alternate_week_b",
            interval: 1,
            weekdays_json: JSON.stringify([1]), // Mondays
            month_day: null,
            year_month: null,
            start_date: "2026-10-19",
            end_date: null,
            week_anchor_monday: anchorMonday,
          },
          "2026-10-19",
          "2026-11-10"
        );
        // Expect: skip 2026-10-19 (Week A), 2026-10-26 (Week B), skip 2026-11-02 (Week A), 2026-11-09 (Week B)
        const altBExpected = ["2026-10-26", "2026-11-09"];
        const altBPass = JSON.stringify(altBDates) === JSON.stringify(altBExpected);

        testResults["TEST-3A.2"] = {
          passed: altAPass && altBPass,
          week_a: { passed: altAPass, generated: altADates, expected: altAExpected },
          week_b: { passed: altBPass, generated: altBDates, expected: altBExpected },
        };
      }

      // TEST-3A.3: repeated materialization creates no duplicate occurrence or notification rows
      if (action === "TEST-3A.3" || action === "ALL") {
        // Create a dedicated test rule
        const rule3 = await createRecurrenceRule(
          env.DB,
          {
            title: "TEST-3A.3 Dedup Rule",
            pattern: "daily",
            interval: 1,
            local_time: "10:00",
            start_date: "2026-10-21",
          },
          now
        );

        const initialOccurrences = rule3.occurrencesCreated;

        // Count occurrences and notifications before second pass
        const countTasks1 = await env.DB.prepare(
          "SELECT COUNT(*) as c FROM tasks WHERE recurrence_rule_id = ?"
        ).bind(rule3.ruleId).first<{ c: number }>();

        const countNotifs1 = await env.DB.prepare(
          "SELECT COUNT(*) as c FROM notification_log WHERE task_id IN (SELECT id FROM tasks WHERE recurrence_rule_id = ?)"
        ).bind(rule3.ruleId).first<{ c: number }>();

        // Run second materialization pass immediately
        const pass2 = await materializeRecurringOccurrences(env.DB, now);

        const countTasks2 = await env.DB.prepare(
          "SELECT COUNT(*) as c FROM tasks WHERE recurrence_rule_id = ?"
        ).bind(rule3.ruleId).first<{ c: number }>();

        const countNotifs2 = await env.DB.prepare(
          "SELECT COUNT(*) as c FROM notification_log WHERE task_id IN (SELECT id FROM tasks WHERE recurrence_rule_id = ?)"
        ).bind(rule3.ruleId).first<{ c: number }>();

        const noDuplicateTasks = countTasks1?.c === countTasks2?.c;
        const noDuplicateNotifs = countNotifs1?.c === countNotifs2?.c;
        const pass2CreatedZeroForThisRule = pass2.occurrencesCreated === 0;

        testResults["TEST-3A.3"] = {
          passed: noDuplicateTasks && noDuplicateNotifs,
          initialOccurrences,
          tasksBefore: countTasks1?.c,
          tasksAfter: countTasks2?.c,
          notifsBefore: countNotifs1?.c,
          notifsAfter: countNotifs2?.c,
        };
      }

      // TEST-3A.4: daily maintenance adds only the next missing date and does not rescan/replan the full horizon
      if (action === "TEST-3A.4" || action === "ALL") {
        const testRule4 = await createRecurrenceRule(
          env.DB,
          {
            title: "TEST-3A.4 Maintenance Rule",
            pattern: "daily",
            interval: 1,
            start_date: "2026-10-21",
          },
          now
        );

        // Rule's next_generation_date is now horizonEnd + 1 day (e.g. 2026-11-05)
        const ruleAfterInit = await env.DB.prepare(
          "SELECT next_generation_date FROM recurrence_rules WHERE id = ?"
        ).bind(testRule4.ruleId).first<{ next_generation_date: string }>();

        // Advance simulated time by 1 day (now + 1 day)
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        // Next horizon end has advanced by 1 day, matching next_generation_date!
        const matResTomorrow = await materializeRecurringOccurrences(env.DB, tomorrow);

        // Verify only 1 new occurrence was created for the new horizon date
        const newCount = await env.DB.prepare(
          "SELECT COUNT(*) as c FROM tasks WHERE recurrence_rule_id = ?"
        ).bind(testRule4.ruleId).first<{ c: number }>();

        const ruleAfterTomorrow = await env.DB.prepare(
          "SELECT next_generation_date FROM recurrence_rules WHERE id = ?"
        ).bind(testRule4.ruleId).first<{ next_generation_date: string }>();

        const onlyOneAdded = (newCount?.c ?? 0) === testRule4.occurrencesCreated + 1;

        testResults["TEST-3A.4"] = {
          passed: onlyOneAdded,
          initialOccurrences: testRule4.occurrencesCreated,
          occurrencesAfterMaintenance: newCount?.c,
          initialNextGenDate: ruleAfterInit?.next_generation_date,
          updatedNextGenDate: ruleAfterTomorrow?.next_generation_date,
        };
      }

      // TEST-3A.5: pause/edit suppresses obsolete future work while preserving history
      if (action === "TEST-3A.5" || action === "ALL") {
        const testRule5 = await createRecurrenceRule(
          env.DB,
          {
            title: "TEST-3A.5 Pause Rule",
            pattern: "daily",
            interval: 1,
            local_time: "09:00",
            start_date: "2026-10-21",
          },
          now
        );

        // Complete the first occurrence to establish history
        const firstTask = await env.DB.prepare(
          "SELECT id, status FROM tasks WHERE recurrence_rule_id = ? ORDER BY occurrence_local_date ASC LIMIT 1"
        ).bind(testRule5.ruleId).first<{ id: string; status: string }>();

        if (firstTask?.id) {
          await env.DB.prepare(
            "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?"
          ).bind(now.toISOString(), firstTask.id).run();
        }

        // Pause the rule
        const pauseRes = await pauseRecurrenceRule(env.DB, testRule5.ruleId, now);

        // Check history: firstTask should STILL be done (preserved!)
        const pastTaskCheck = firstTask?.id
          ? await env.DB.prepare(
              "SELECT status FROM tasks WHERE id = ?"
            ).bind(firstTask.id).first<{ status: string }>()
          : null;

        // Future tasks should be dismissed
        const futureTasksOpen = await env.DB.prepare(
          "SELECT COUNT(*) as c FROM tasks WHERE recurrence_rule_id = ? AND status = 'open'"
        ).bind(testRule5.ruleId).first<{ c: number }>();

        // Future notifications should be suppressed
        const futureNotifsPending = await env.DB.prepare(
          `SELECT COUNT(*) as c FROM notification_log
           WHERE task_id IN (SELECT id FROM tasks WHERE recurrence_rule_id = ?)
             AND status IN ('pending', 'claimed')`
        ).bind(testRule5.ruleId).first<{ c: number }>();

        const historyPreserved = pastTaskCheck?.status === "done";
        const futureSuppressed = (futureTasksOpen?.c ?? 1) === 0 && (futureNotifsPending?.c ?? 1) === 0;

        testResults["TEST-3A.5"] = {
          passed: historyPreserved && futureSuppressed && pauseRes.success,
          historyPreserved,
          pastTaskStatus: pastTaskCheck?.status,
          futureTasksOpenCount: futureTasksOpen?.c,
          futureNotifsPendingCount: futureNotifsPending?.c,
          suppressedTasks: pauseRes.suppressedTasks,
          suppressedNotifications: pauseRes.suppressedNotifications,
        };
      }

      // TEST-3A.6: completing one occurrence does not accidentally complete future occurrences
      if (action === "TEST-3A.6" || action === "ALL") {
        const testRule6 = await createRecurrenceRule(
          env.DB,
          {
            title: "TEST-3A.6 Single Occurrence Rule",
            pattern: "daily",
            interval: 1,
            start_date: "2026-10-21",
          },
          now
        );

        // Fetch first two occurrences
        const tasks = await env.DB.prepare(
          "SELECT id, occurrence_number, status FROM tasks WHERE recurrence_rule_id = ? ORDER BY occurrence_number ASC LIMIT 2"
        ).bind(testRule6.ruleId).all<{ id: string; occurrence_number: number; status: string }>();

        const task1 = tasks.results[0];
        const task2 = tasks.results[1];

        if (task1?.id) {
          // Mark task1 done
          await env.DB.prepare(
            "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?"
          ).bind(now.toISOString(), task1.id).run();
        }

        // Re-read task1 and task2
        const check1 = task1?.id
          ? await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind(task1.id).first<{ status: string }>()
          : null;
        const check2 = task2?.id
          ? await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind(task2.id).first<{ status: string }>()
          : null;

        // Check rule active status
        const ruleCheck = await env.DB.prepare("SELECT active FROM recurrence_rules WHERE id = ?").bind(testRule6.ruleId).first<{ active: number }>();

        const task1Done = check1?.status === "done";
        const task2StillOpen = check2?.status === "open";
        const ruleStillActive = ruleCheck?.active === 1;

        testResults["TEST-3A.6"] = {
          passed: task1Done && task2StillOpen && ruleStillActive,
          task1Status: check1?.status,
          task2Status: check2?.status,
          ruleActive: ruleCheck?.active,
        };
      }

      // Monthly clamping and Leap-year test
      if (action === "TEST-3A.MONTH_LEAP" || action === "ALL") {
        // Month clamping: Jan 31 -> Feb 28 -> Mar 31
        const month31Dates = calculateNextOccurrenceDates(
          {
            pattern: "monthly",
            interval: 1,
            weekdays_json: null,
            month_day: 31,
            year_month: null,
            start_date: "2026-01-31",
            end_date: null,
            week_anchor_monday: null,
          },
          "2026-01-31",
          "2026-04-01"
        );
        const month31Expected = ["2026-01-31", "2026-02-28", "2026-03-31"];
        const month31Pass = JSON.stringify(month31Dates) === JSON.stringify(month31Expected);

        // Leap year clamping: Feb 29
        const leap2026Dates = calculateNextOccurrenceDates(
          {
            pattern: "yearly",
            interval: 1,
            weekdays_json: null,
            month_day: 29,
            year_month: 2,
            start_date: "2026-02-28",
            end_date: null,
            week_anchor_monday: null,
          },
          "2026-01-01",
          "2028-12-31"
        );
        // 2026 (non-leap: 2026-02-28), 2027 (non-leap: 2027-02-28), 2028 (leap year: 2028-02-29!)
        const leapExpected = ["2026-02-28", "2027-02-28", "2028-02-29"];
        const leapPass = JSON.stringify(leap2026Dates) === JSON.stringify(leapExpected);

        // Last day of month (-1)
        const lastDayDates = calculateNextOccurrenceDates(
          {
            pattern: "monthly",
            interval: 1,
            weekdays_json: null,
            month_day: -1,
            year_month: null,
            start_date: "2026-01-01",
            end_date: null,
            week_anchor_monday: null,
          },
          "2026-01-01",
          "2026-03-31"
        );
        const lastDayExpected = ["2026-01-31", "2026-02-28", "2026-03-31"];
        const lastDayPass = JSON.stringify(lastDayDates) === JSON.stringify(lastDayExpected);

        testResults["TEST-3A.MONTH_LEAP"] = {
          passed: month31Pass && leapPass && lastDayPass,
          month31: { passed: month31Pass, generated: month31Dates, expected: month31Expected },
          leapYear: { passed: leapPass, generated: leap2026Dates, expected: leapExpected },
          lastDay: { passed: lastDayPass, generated: lastDayDates, expected: lastDayExpected },
        };
      }

      // Shorthand parser test
      if (action === "TEST-3A.PARSER" || action === "ALL") {
        const cases = [
          { raw: "every day", expectedPattern: "daily", expectedInterval: 1 },
          { raw: "every 2 days", expectedPattern: "daily", expectedInterval: 2 },
          { raw: "every week", expectedPattern: "weekly", expectedInterval: 1 },
          { raw: "every 3 weeks", expectedPattern: "weekly", expectedInterval: 3 },
          { raw: "every month", expectedPattern: "monthly", expectedInterval: 1 },
          { raw: "every 2 months", expectedPattern: "monthly", expectedInterval: 2 },
          { raw: "every year", expectedPattern: "yearly", expectedInterval: 1 },
          { raw: "every monday 18:00", expectedPattern: "selected_weekdays", expectedTime: "18:00" },
          { raw: "every friday 09:00", expectedPattern: "selected_weekdays", expectedTime: "09:00" },
          { raw: "15th day of month", expectedPattern: "monthly", expectedMonthDay: 15 },
          { raw: "last day of month", expectedPattern: "monthly", expectedMonthDay: -1 },
          { raw: "every Dec 25", expectedPattern: "yearly", expectedMonth: 12, expectedMonthDay: 25 },
          { raw: "alternate week a", expectedPattern: "alternate_week_a" },
        ];

        let parserPassed = true;
        const details: any[] = [];
        for (const c of cases) {
          const res = parseRecurrenceShorthand(c.raw, now);
          const ok =
            res.isRecurrence &&
            res.ruleInput?.pattern === c.expectedPattern &&
            (c.expectedInterval === undefined || res.ruleInput?.interval === c.expectedInterval) &&
            (c.expectedTime === undefined || res.ruleInput?.local_time === c.expectedTime) &&
            (c.expectedMonthDay === undefined || res.ruleInput?.month_day === c.expectedMonthDay) &&
            (c.expectedMonth === undefined || res.ruleInput?.year_month === c.expectedMonth);

          if (!ok) parserPassed = false;
          details.push({ input: c.raw, ok, parsed: res.ruleInput });
        }

        testResults["TEST-3A.PARSER"] = { passed: parserPassed, details };
      }

      const allPassed = Object.values(testResults).every((t: any) => t.passed === true);
      return Response.json({ ok: true, allPassed, results: testResults });
    }

    // ==========================================
    // Block 3B: Timetable REST Endpoints
    // ==========================================

    // GET /api/v1/timetable (or with ?preview=14)
    if (request.method === "GET" && url.pathname === "/api/v1/timetable") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const activeSem = await getActiveSemester(env.DB);
      if (!activeSem) {
        return Response.json({ ok: true, activeSemester: null, message: "No active semester." });
      }

      const previewDays = parseInt(url.searchParams.get("preview") || "0", 10);
      if (previewDays > 0) {
        const ist = getISTDateParts(new Date());
        const preview = await getSchedulePreview(env.DB, ist.localDate, addDaysYmd(ist.localDate, previewDays));
        return Response.json({ ok: true, activeSemester: activeSem, preview });
      }

      const subjects = await env.DB.prepare("SELECT * FROM timetable_subjects WHERE semester_id = ?").bind(activeSem.id).all();
      const slots = await env.DB.prepare("SELECT * FROM timetable_slots WHERE semester_id = ? AND active = 1").bind(activeSem.id).all();
      const holidays = await env.DB.prepare("SELECT * FROM holiday_calendar ORDER BY holiday_date ASC").all();

      return Response.json({
        ok: true,
        activeSemester: activeSem,
        subjects: subjects.results || [],
        slots: slots.results || [],
        holidays: holidays.results || [],
      });
    }

    // POST /api/v1/timetable — Create semester, subject, slot, material, exception, or holiday
    if (request.method === "POST" && url.pathname === "/api/v1/timetable") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await request.json()) as any;
      const type = body.type;
      const nowIso = new Date().toISOString();

      if (type === "semester") {
        const id = body.id || crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, body.name, body.start_date, body.end_date, body.is_active ? 1 : 0, body.external_id ?? null, nowIso, nowIso).run();

        if (body.is_active) {
          await activateSemester(env.DB, id);
        }
        return Response.json({ ok: true, id, type: "semester" });
      }

      if (type === "subject") {
        const id = body.id || crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, default_room, color, section_name, preparation_minutes, external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, body.semester_id, body.code ?? null, body.name, body.faculty ?? null,
          body.default_room ?? null, body.color ?? "#3b82f6", body.section_name ?? null,
          body.preparation_minutes ?? 45, body.external_id ?? null, nowIso, nowIso
        ).run();
        return Response.json({ ok: true, id, type: "subject" });
      }

      if (type === "slot") {
        const id = body.id || crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, week_pattern, lab_batch, week_anchor_monday, section_name, active, external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, body.semester_id, body.subject_id, body.weekday, body.start_time, body.end_time,
          body.room ?? null, body.week_pattern ?? "every_week", body.lab_batch ?? null,
          body.week_anchor_monday ?? null, body.section_name ?? null, 1, body.external_id ?? null, nowIso, nowIso
        ).run();
        await materializeTimetableOccurrences(env.DB, new Date());
        return Response.json({ ok: true, id, type: "slot" });
      }

      if (type === "material") {
        const id = body.id || crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_materials (id, slot_id, material_type, title, notes, required, display_order, active, external_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        ).bind(id, body.slot_id, body.material_type ?? "other", body.title, body.notes ?? null, body.required !== false ? 1 : 0, body.display_order ?? 0, body.external_id ?? null, nowIso, nowIso).run();
        return Response.json({ ok: true, id, type: "material" });
      }

      if (type === "holiday") {
        const id = body.id || crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO holiday_calendar (id, name, holiday_date, is_full_day, holiday_scope, external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name`
        ).bind(id, body.name, body.holiday_date, body.is_full_day !== false ? 1 : 0, body.holiday_scope ?? "college", body.external_id ?? null, nowIso).run();
        return Response.json({ ok: true, id, type: "holiday" });
      }

      if (type === "exception") {
        const id = body.id || crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_exceptions (id, slot_id, exception_type, start_date, end_date, new_date, new_start_time, new_end_time, reason, external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, body.slot_id ?? null, body.exception_type, body.start_date, body.end_date,
          body.new_date ?? null, body.new_start_time ?? null, body.new_end_time ?? null,
          body.reason ?? null, body.external_id ?? null, nowIso
        ).run();
        return Response.json({ ok: true, id, type: "exception" });
      }

      return Response.json({ ok: false, error: "unknown_type" }, { status: 400 });
    }

    // PATCH /api/v1/timetable/:id
    const timetablePatchMatch = url.pathname.match(/^\/api\/v1\/timetable\/([^/]+)$/);
    if (request.method === "PATCH" && timetablePatchMatch) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const id = timetablePatchMatch[1];
      const body = (await request.json()) as any;
      const nowIso = new Date().toISOString();

      // Check slot update
      if (body.room !== undefined || body.start_time !== undefined || body.end_time !== undefined) {
        await env.DB.prepare(
          `UPDATE timetable_slots SET room = coalesce(?, room), start_time = coalesce(?, start_time), end_time = coalesce(?, end_time), updated_at = ? WHERE id = ?`
        ).bind(body.room ?? null, body.start_time ?? null, body.end_time ?? null, nowIso, id).run();
      }

      return Response.json({ ok: true, updated: id });
    }

    // DELETE /api/v1/timetable/:id
    const timetableDeleteMatch = url.pathname.match(/^\/api\/v1\/timetable\/([^/]+)$/);
    if (request.method === "DELETE" && timetableDeleteMatch) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const id = timetableDeleteMatch[1];
      const nowIso = new Date().toISOString();
      await env.DB.prepare("UPDATE timetable_slots SET active = 0, updated_at = ? WHERE id = ?").bind(nowIso, id).run();
      return Response.json({ ok: true, deleted: id });
    }

    // GET /api/v1/today & GET /api/v1/classes/today
    if (request.method === "GET" && (url.pathname === "/api/v1/today" || url.pathname === "/api/v1/classes/today")) {
      const ist = getISTDateParts(new Date());
      const classes = await getClassesForDate(env.DB, ist.localDate);
      return Response.json({ ok: true, date: ist.localDate, classes });
    }

    // GET /api/v1/tomorrow & GET /api/v1/preparation/tomorrow
    if (request.method === "GET" && (url.pathname === "/api/v1/tomorrow" || url.pathname === "/api/v1/preparation/tomorrow")) {
      const ist = getISTDateParts(new Date());
      const tomorrowYmd = addDaysYmd(ist.localDate, 1);
      const prepData = await getPrepDigestData(env.DB, tomorrowYmd);
      const renderedMessage = await renderPrepDigestMessage(env.DB, tomorrowYmd);
      return Response.json({ ok: true, ...prepData, renderedMessage });
    }

    // GET /api/v1/classes/week
    if (request.method === "GET" && url.pathname === "/api/v1/classes/week") {
      const ist = getISTDateParts(new Date());
      const preview = await getSchedulePreview(env.DB, ist.localDate, addDaysYmd(ist.localDate, 7));
      return Response.json({ ok: true, preview });
    }

    // POST /api/v1/internal/test/timetable — Acceptance Test Runner (TEST-3B.1 to TEST-3B.7)
    if (request.method === "POST" && url.pathname === "/api/v1/internal/test/timetable") {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const authHeader = request.headers.get("Authorization");
      const isAuth =
        (secretHeader && secretHeader === env.TELEGRAM_WEBHOOK_SECRET) ||
        (authHeader && authHeader === `Bearer ${env.TELEGRAM_WEBHOOK_SECRET}`);

      if (!isAuth) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = (await request.json()) as any;
      const action = body.action || "ALL";
      const now = body.now ? new Date(body.now) : new Date("2026-10-19T06:00:00.000Z"); // Monday 2026-10-19
      const testResults: Record<string, any> = {};
      const nowIso = now.toISOString();

      // Clean up test holidays and exceptions before running suite
      await env.DB.prepare("DELETE FROM holiday_calendar WHERE holiday_date = '2026-10-21'").run();
      await env.DB.prepare("DELETE FROM timetable_exceptions WHERE reason = 'Mid-Term Break'").run();

      // TEST-3B.1: Class timetable for a normal week creates expected class occurrences
      if (action === "TEST-3B.1" || action === "ALL") {
        const semId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
           VALUES (?, 'TEST-3B.1 Semester', '2026-10-19', '2026-11-30', 1, ?, ?)`
        ).bind(semId, nowIso, nowIso).run();
        await activateSemester(env.DB, semId, now);

        const subjId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, default_room, preparation_minutes, created_at, updated_at)
           VALUES (?, ?, 'CS101', 'Intro to Computer Science', 'Prof. Alan', 'Hall A', 30, ?, ?)`
        ).bind(subjId, semId, nowIso, nowIso).run();

        // Slots: Mon(1), Wed(3), Fri(5) at 09:00 - 10:00
        const slot1 = crypto.randomUUID();
        const slot2 = crypto.randomUUID();
        const slot3 = crypto.randomUUID();

        await env.DB.batch([
          env.DB.prepare("INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at) VALUES (?, ?, ?, 1, '09:00', '10:00', 'Hall A', ?, ?)").bind(slot1, semId, subjId, nowIso, nowIso),
          env.DB.prepare("INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at) VALUES (?, ?, ?, 3, '09:00', '10:00', 'Hall A', ?, ?)").bind(slot2, semId, subjId, nowIso, nowIso),
          env.DB.prepare("INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at) VALUES (?, ?, ?, 5, '09:00', '10:00', 'Hall A', ?, ?)").bind(slot3, semId, subjId, nowIso, nowIso),
        ]);

        const matRes = await materializeTimetableOccurrences(env.DB, now, 7);

        // Fetch generated occurrences for this semester in week 2026-10-19 to 2026-10-25
        const occs = await env.DB.prepare(
          `SELECT occurrence_date, start_time FROM class_occurrences WHERE semester_id = ? AND occurrence_date <= '2026-10-25' ORDER BY occurrence_date ASC`
        ).bind(semId).all<{ occurrence_date: string; start_time: string }>();

        const dates = (occs.results || []).map((o) => o.occurrence_date);
        const expectedDates = ["2026-10-19", "2026-10-21", "2026-10-23"]; // Mon, Wed, Fri
        const pass = JSON.stringify(dates) === JSON.stringify(expectedDates);

        testResults["TEST-3B.1"] = {
          passed: pass,
          generatedDates: dates,
          expectedDates,
          occurrencesCreated: matRes.occurrencesCreated,
          remindersPlanned: matRes.remindersPlanned,
        };
      }

      // TEST-3B.2: Alternating A/B or lab-batch timetable entries follow their explicit pattern/anchor
      if (action === "TEST-3B.2" || action === "ALL") {
        const semId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
           VALUES (?, 'TEST-3B.2 Semester', '2026-10-19', '2026-11-30', 1, ?, ?)`
        ).bind(semId, nowIso, nowIso).run();
        await activateSemester(env.DB, semId, now);

        const subjId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, created_at, updated_at)
           VALUES (?, ?, 'PH102', 'Physics Lab', 'Dr. Raman', ?, ?)`
        ).bind(subjId, semId, nowIso, nowIso).run();

        const anchorMonday = "2026-10-19";

        // Slot A: Alternate Week A on Tuesday (2) 14:00 - 17:00
        const slotAId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, week_pattern, lab_batch, week_anchor_monday, created_at, updated_at)
           VALUES (?, ?, ?, 2, '14:00', '17:00', 'Lab 1', 'alternate_a', 'Batch A', ?, ?, ?)`
        ).bind(slotAId, semId, subjId, anchorMonday, nowIso, nowIso).run();

        // Slot B: Alternate Week B on Tuesday (2) 14:00 - 17:00
        const slotBId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, week_pattern, lab_batch, week_anchor_monday, created_at, updated_at)
           VALUES (?, ?, ?, 2, '14:00', '17:00', 'Lab 1', 'alternate_b', 'Batch B', ?, ?, ?)`
        ).bind(slotBId, semId, subjId, anchorMonday, nowIso, nowIso).run();

        await materializeTimetableOccurrences(env.DB, now, 14);

        const occsA = await env.DB.prepare("SELECT occurrence_date FROM class_occurrences WHERE slot_id = ? ORDER BY occurrence_date ASC").bind(slotAId).all<{ occurrence_date: string }>();
        const occsB = await env.DB.prepare("SELECT occurrence_date FROM class_occurrences WHERE slot_id = ? ORDER BY occurrence_date ASC").bind(slotBId).all<{ occurrence_date: string }>();

        const datesA = (occsA.results || []).map((o) => o.occurrence_date);
        const datesB = (occsB.results || []).map((o) => o.occurrence_date);

        // Week of 2026-10-19 is Week A -> Tuesday is 2026-10-20
        // Week of 2026-10-26 is Week B -> Tuesday is 2026-10-27
        const passA = datesA.includes("2026-10-20") && !datesA.includes("2026-10-27");
        const passB = !datesB.includes("2026-10-20") && datesB.includes("2026-10-27");

        testResults["TEST-3B.2"] = {
          passed: passA && passB,
          slotA_WeekA_Dates: datesA,
          slotB_WeekB_Dates: datesB,
        };
      }

      // TEST-3B.3: Tomorrow's lab materials appear in the single 20:30 prep digest; no separate per-material sends
      if (action === "TEST-3B.3" || action === "ALL") {
        const semId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
           VALUES (?, 'TEST-3B.3 Semester', '2026-10-19', '2026-11-30', 1, ?, ?)`
        ).bind(semId, nowIso, nowIso).run();
        await activateSemester(env.DB, semId, now);

        const subjId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, created_at, updated_at)
           VALUES (?, ?, 'CH103', 'Chemistry Lab', 'Dr. Marie', ?, ?)`
        ).bind(subjId, semId, nowIso, nowIso).run();

        // Tuesday slot (weekday 2) -> tomorrow is Tuesday 2026-10-20
        const slotId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at)
           VALUES (?, ?, ?, 2, '10:00', '13:00', 'Chem Lab', ?, ?)`
        ).bind(slotId, semId, subjId, nowIso, nowIso).run();

        // Attach materials: Lab Manual, Observation Book, Safety Goggles
        await env.DB.batch([
          env.DB.prepare("INSERT INTO timetable_materials (id, slot_id, material_type, title, notes, display_order, created_at, updated_at) VALUES (?, ?, 'lab_manual', 'Chemistry Lab Manual', 'Exp 4 signed', 1, ?, ?)").bind(crypto.randomUUID(), slotId, nowIso, nowIso),
          env.DB.prepare("INSERT INTO timetable_materials (id, slot_id, material_type, title, notes, display_order, created_at, updated_at) VALUES (?, ?, 'observation_book', 'Observation Notebook', NULL, 2, ?, ?)").bind(crypto.randomUUID(), slotId, nowIso, nowIso),
          env.DB.prepare("INSERT INTO timetable_materials (id, slot_id, material_type, title, notes, display_order, created_at, updated_at) VALUES (?, ?, 'other', 'Safety Goggles', 'Mandatory for entry', 3, ?, ?)").bind(crypto.randomUUID(), slotId, nowIso, nowIso),
        ]);

        await materializeTimetableOccurrences(env.DB, now, 7);

        // Target date = tomorrow = 2026-10-20
        const tomorrowYmd = "2026-10-20";
        const digestData = await getPrepDigestData(env.DB, tomorrowYmd);
        const digestMsg = await renderPrepDigestMessage(env.DB, tomorrowYmd);

        // Check deduplication in notification_log: exactly ONE prep-digest:2026-10-20 row
        const notifRows = await env.DB.prepare(
          "SELECT id, dedup_key FROM notification_log WHERE dedup_key = ?"
        ).bind(`prep-digest:${tomorrowYmd}`).all();

        const hasMaterials = digestData.classes[0]?.materials.length === 3;
        const msgContainsManual = digestMsg.includes("Chemistry Lab Manual");
        const msgContainsGoggles = digestMsg.includes("Safety Goggles");
        const singleNotifRow = notifRows.results.length === 1;

        testResults["TEST-3B.3"] = {
          passed: hasMaterials && msgContainsManual && msgContainsGoggles && singleNotifRow,
          materialsCount: digestData.classes[0]?.materials.length,
          singleNotifRow,
          renderedMessage: digestMsg,
        };
      }

      // TEST-3B.4: Global vacation/exam no-class range suppresses all affected classes; per-entry exceptions skip/move
      if (action === "TEST-3B.4" || action === "ALL") {
        const semId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
           VALUES (?, 'TEST-3B.4 Semester', '2026-10-19', '2026-11-30', 1, ?, ?)`
        ).bind(semId, nowIso, nowIso).run();
        await activateSemester(env.DB, semId, now);

        const subjId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, created_at, updated_at)
           VALUES (?, ?, 'MA104', 'Mathematics', 'Prof. Euler', ?, ?)`
        ).bind(subjId, semId, nowIso, nowIso).run();

        // Slot on Wednesday (3)
        const slotId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at)
           VALUES (?, ?, ?, 3, '11:00', '12:00', 'Room 303', ?, ?)`
        ).bind(slotId, semId, subjId, nowIso, nowIso).run();

        // Add a holiday on Wednesday 2026-10-21
        await env.DB.prepare(
          `INSERT INTO holiday_calendar (id, name, holiday_date, is_full_day, holiday_scope, created_at)
           VALUES (?, 'Festival Holiday', '2026-10-21', 1, 'college', ?)
           ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name`
        ).bind(crypto.randomUUID(), nowIso).run();

        // Add global no_classes vacation from 2026-10-27 to 2026-10-29
        await env.DB.prepare(
          `INSERT INTO timetable_exceptions (id, slot_id, exception_type, start_date, end_date, reason, created_at)
           VALUES (?, NULL, 'no_classes', '2026-10-27', '2026-10-29', 'Mid-Term Break', ?)`
        ).bind(crypto.randomUUID(), nowIso).run();

        await materializeTimetableOccurrences(env.DB, now, 21);

        // Fetch occurrences for this slot
        const occs = await env.DB.prepare("SELECT occurrence_date FROM class_occurrences WHERE slot_id = ?").bind(slotId).all<{ occurrence_date: string }>();
        const dates = (occs.results || []).map((o) => o.occurrence_date);

        // Wednesday 2026-10-21 is Holiday -> MUST BE SUPPRESSED
        const holidaySuppressed = !dates.includes("2026-10-21");
        // Wednesday 2026-10-28 is in Mid-Term Break (no_classes) -> MUST BE SUPPRESSED
        const breakSuppressed = !dates.includes("2026-10-28");
        // Wednesday 2026-11-04 is regular -> MUST BE PRESENT
        const normalWednesdayPresent = dates.includes("2026-11-04");

        // Cleanup test-specific holiday and exception
        await env.DB.prepare("DELETE FROM holiday_calendar WHERE holiday_date = '2026-10-21'").run();
        await env.DB.prepare("DELETE FROM timetable_exceptions WHERE reason = 'Mid-Term Break'").run();

        testResults["TEST-3B.4"] = {
          passed: holidaySuppressed && breakSuppressed && normalWednesdayPresent,
          holidaySuppressed,
          breakSuppressed,
          normalWednesdayPresent,
          generatedDates: dates,
        };
      }

      // TEST-3B.5: Editing a material/timetable entry updates future unsent digests without sending a duplicate
      if (action === "TEST-3B.5" || action === "ALL") {
        const semId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
           VALUES (?, 'TEST-3B.5 Semester', '2026-10-19', '2026-11-30', 1, ?, ?)`
        ).bind(semId, nowIso, nowIso).run();
        await activateSemester(env.DB, semId, now);

        const subjId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_subjects (id, semester_id, code, name, faculty, created_at, updated_at)
           VALUES (?, ?, 'EE105', 'Circuit Lab', 'Dr. Ohm', ?, ?)`
        ).bind(subjId, semId, nowIso, nowIso).run();

        // Tuesday slot (2026-10-20)
        const slotId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at)
           VALUES (?, ?, ?, 2, '14:00', '16:00', 'EE Lab', ?, ?)`
        ).bind(slotId, semId, subjId, nowIso, nowIso).run();

        const matId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_materials (id, slot_id, material_type, title, notes, created_at, updated_at)
           VALUES (?, ?, 'calculator', 'Scientific Calculator', 'Casio fx-991', ?, ?)`
        ).bind(matId, slotId, nowIso, nowIso).run();

        await materializeTimetableOccurrences(env.DB, now, 7);

        // Edit material note
        await env.DB.prepare(
          `UPDATE timetable_materials SET title = 'Scientific Calculator (FX-991CW)', notes = 'Bring spare batteries', updated_at = ? WHERE id = ?`
        ).bind(nowIso, matId).run();

        // Re-render digest: must reflect edited material title dynamically!
        const targetYmd = "2026-10-20";
        const msgAfterEdit = await renderPrepDigestMessage(env.DB, targetYmd);

        const containsEditedTitle = msgAfterEdit.includes("Scientific Calculator (FX-991CW)");
        const containsNewNote = msgAfterEdit.includes("Bring spare batteries");

        testResults["TEST-3B.5"] = {
          passed: containsEditedTitle && containsNewNote,
          containsEditedTitle,
          containsNewNote,
          renderedMessage: msgAfterEdit,
        };
      }

      // TEST-3B.6: IST midnight/date boundaries do not shift classes/materials to the prior UTC date
      if (action === "TEST-3B.6" || action === "ALL") {
        // Late night / early morning test:
        // A class at 07:00 IST on 2026-10-20 is 01:30 UTC on 2026-10-20 (same day).
        // A late class at 20:30 IST on 2026-10-20 is 15:00 UTC on 2026-10-20 (same day).
        // Preparation digest planned at 20:30 IST on 2026-10-19 is 15:00 UTC on 2026-10-19.
        const istEarly = istToUtcDate("2026-10-20", "07:00");
        const istEarlyParts = getISTDateParts(istEarly);

        const istLate = istToUtcDate("2026-10-20", "20:30");
        const istLateParts = getISTDateParts(istLate);

        const earlyMatches = istEarlyParts.localDate === "2026-10-20" && istEarlyParts.localTime === "07:00";
        const lateMatches = istLateParts.localDate === "2026-10-20" && istLateParts.localTime === "20:30";

        testResults["TEST-3B.6"] = {
          passed: earlyMatches && lateMatches,
          earlyIST: istEarlyParts,
          lateIST: istLateParts,
        };
      }

      // TEST-3B.7: Owner can preview next 7–14 days and inspect timetable
      if (action === "TEST-3B.7" || action === "ALL") {
        const preview = await getSchedulePreview(env.DB, "2026-10-19", "2026-11-01");
        const pass = Array.isArray(preview) && preview.length === 14;

        testResults["TEST-3B.7"] = {
          passed: pass,
          daysCount: preview.length,
          startDate: preview[0]?.date,
          endDate: preview[preview.length - 1]?.date,
        };
      }

      // Edge Cases: Mid-week semester end & simultaneous classes
      if (action === "EDGE_CASES" || action === "ALL") {
        // 1. Mid-week semester end
        const semId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_semesters (id, name, start_date, end_date, is_active, created_at, updated_at)
           VALUES (?, 'MidWeek End Semester', '2026-10-19', '2026-10-22', 1, ?, ?)` // Ends on Thursday 2026-10-22
        ).bind(semId, nowIso, nowIso).run();
        await activateSemester(env.DB, semId, now);

        const subjId = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_subjects (id, semester_id, code, name, created_at, updated_at)
           VALUES (?, ?, 'CS999', 'Capstone', ?, ?)`
        ).bind(subjId, semId, nowIso, nowIso).run();

        // Slot on Friday (5) -> after semester end!
        const slotFriday = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, created_at, updated_at)
           VALUES (?, ?, ?, 5, '10:00', '11:00', ?, ?)`
        ).bind(slotFriday, semId, subjId, nowIso, nowIso).run();

        // Slot on Wednesday (3) -> before semester end!
        const slotWed = crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, created_at, updated_at)
           VALUES (?, ?, ?, 3, '10:00', '11:00', ?, ?)`
        ).bind(slotWed, semId, subjId, nowIso, nowIso).run();

        await materializeTimetableOccurrences(env.DB, now, 14);

        const occWed = await env.DB.prepare("SELECT * FROM class_occurrences WHERE slot_id = ?").bind(slotWed).all();
        const occFri = await env.DB.prepare("SELECT * FROM class_occurrences WHERE slot_id = ?").bind(slotFriday).all();

        const midWeekPass = occWed.results.length === 1 && occFri.results.length === 0;

        // 2. Simultaneous classes (two classes starting at 09:00 in different rooms)
        const slotSim1 = crypto.randomUUID();
        const slotSim2 = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at) VALUES (?, ?, ?, 1, '09:00', '10:00', 'Room 101', ?, ?)").bind(slotSim1, semId, subjId, nowIso, nowIso),
          env.DB.prepare("INSERT INTO timetable_slots (id, semester_id, subject_id, weekday, start_time, end_time, room, created_at, updated_at) VALUES (?, ?, ?, 1, '09:00', '10:00', 'Room 102', ?, ?)").bind(slotSim2, semId, subjId, nowIso, nowIso),
        ]);

        await materializeTimetableOccurrences(env.DB, now, 7);

        const occSim1 = await env.DB.prepare("SELECT * FROM class_occurrences WHERE slot_id = ?").bind(slotSim1).first();
        const occSim2 = await env.DB.prepare("SELECT * FROM class_occurrences WHERE slot_id = ?").bind(slotSim2).first();

        const simPass = !!occSim1 && !!occSim2;

        testResults["EDGE_CASES"] = {
          passed: midWeekPass && simPass,
          midWeekPass,
          simultaneousPass: simPass,
        };
      }

      const allPassed = Object.values(testResults).every((t: any) => t.passed === true);
      return Response.json({ ok: true, allPassed, results: testResults });
    }

    // Telegram webhook endpoint and command routing
    if (request.method === "POST" && (url.pathname === "/api/v1/telegram/webhook" || url.pathname === "/webhook")) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      const configuredSecret = env.TELEGRAM_WEBHOOK_SECRET;

      // TEST-1.2: Reject missing or invalid secret token
      if (!secretHeader || secretHeader !== configuredSecret) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload: any;
      try {
        payload = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const updateId = payload?.update_id;
      if (typeof updateId !== "number") {
        return new Response("Invalid update_id", { status: 400 });
      }

      // TEST-1.1: Verify owner ID — no DB mutation, no meaningful reply
      const senderId = payload?.message?.from?.id ?? payload?.callback_query?.from?.id;
      const chatId = payload?.message?.chat?.id ?? payload?.callback_query?.message?.chat?.id;
      const ownerId = env.TELEGRAM_OWNER_ID;
      if (ownerId && senderId !== undefined && String(senderId) !== String(ownerId)) {
        return Response.json({ ok: true, ignored: true });
      }

      // TEST-1.4: Inbound ledger deduplication
      const existing = await env.DB.prepare(
        "SELECT update_id, status FROM telegram_updates WHERE update_id = ?"
      )
        .bind(updateId)
        .first();

      if (existing) {
        return Response.json({ ok: true, duplicate: true });
      }

      // Record update receipt in ledger
      await env.DB.prepare(
        "INSERT INTO telegram_updates (update_id, status, received_at) VALUES (?, 'received', datetime('now'))"
      )
        .bind(updateId)
        .run();

      // Block 2A & 2B: Handle callback_query (Done, Snooze, Details inline buttons)
      if (payload?.callback_query) {
        const callbackResult = await handleCallbackQuery(payload.callback_query, env, updateId);
        if (payload.callback_query.id) {
          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, payload.callback_query.id, callbackResult.message);
        }
        return Response.json({
          ok: true,
          routed: true,
          callback: callbackResult,
          result: callbackResult.message,
        });
      }

      // Route command if present; otherwise capture plain-text as task (BLOCK_1.md)
      const messageText = typeof payload?.message?.text === "string" ? payload.message.text : "";
      const context = { db: env.DB, updateId, senderId, chatId, env };

      let routed = await routeCommand(messageText, context);

      // Plain-text (non-command, non-empty) → capture verbatim as a task with no date
      if (routed === null && messageText.trim() && !messageText.trim().startsWith("/")) {
        routed = await handlePlainText(messageText, context);
      }

      // Durable write committed inside each handler via DB.batch() BEFORE this point.
      // Send reply AFTER commit. If send fails, still return HTTP 200 —
      // do NOT repeat the mutation (BLOCK_1.md).
      if (routed?.response && chatId !== undefined) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, routed.response, (routed as any)?.replyMarkup).catch(() => {
          // Swallow — reply failure must not affect the HTTP response or cause a retry
        });
      }

      return Response.json({
        ok: true,
        routed: routed !== null,
        command: routed?.command ?? null,
        success: routed?.success ?? true,
        taskId: routed?.taskId ?? null,
        deadline: routed?.deadline ?? null,
        tasks: routed?.tasks ?? null,
        proposals: (routed as any)?.proposals ?? null,
        result: routed?.response ?? null,
      });
    }

    return new Response(null, { status: 404 });
  },

  // Block 2A & 2B: One-minute Cron Trigger scheduler entrypoint
  async scheduled(controller, env): Promise<void> {
    const scheduledTime = controller.scheduledTime ? new Date(controller.scheduledTime) : new Date();
    console.log({
      hasBotToken: !!env.TELEGRAM_BOT_TOKEN,
      ownerId: env.TELEGRAM_OWNER_ID,
      ownerType: typeof env.TELEGRAM_OWNER_ID,
    });
    await runScheduler(env.DB, scheduledTime, undefined, {
      botToken: env.TELEGRAM_BOT_TOKEN,
      ownerChatId: env.TELEGRAM_OWNER_ID,
      pingUrl: env.HEALTHCHECKS_PING_URL,
    });
  },
} satisfies ExportedHandler<Env>;
