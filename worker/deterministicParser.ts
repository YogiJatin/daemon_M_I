/**
 * worker/deterministicParser.ts — Deterministic-First Reminder & Intent Parser (A2, A4)
 *
 * Implements regex and rule-based parsing before calling any LLM:
 * - "remind me to <title> in <N> min/hours"
 * - "remind me at <time> to <title>"
 * - "remind me <date/anchor> to <title>"
 * - "buy <item> at <time>"
 * - "submit <item> by tonight"
 * - Hindi/Telugu words via parseRegionalDateWords (kal, repu, aaj, parso)
 * - /add <title>
 * - Multi-intent splitting into <= 3 clauses
 *
 * 100% offline, 0 LLM calls, zero AI dependency.
 */

import { parseRegionalDateWords } from "./dateLexicon";
import { formatConfirmationDate } from "./telegramAssistant";

export interface ParsedReminder {
  title: string;
  localDate: string; // YYYY-MM-DD (IST)
  localTime: string; // HH:mm (IST)
  dueAtFormatted: string;
  remindAtFormatted: string;
  dueDifferentFromRemind: boolean;
  anchor: string;
  confidence: number;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function getNowIst(now: Date = new Date()): { dateIst: string; timeIst: string; dateObj: Date } {
  const istTime = new Date(now.getTime() + IST_OFFSET_MS);
  const dateIst = istTime.toISOString().slice(0, 10);
  const hours = String(istTime.getUTCHours()).padStart(2, "0");
  const minutes = String(istTime.getUTCMinutes()).padStart(2, "0");
  return { dateIst, timeIst: `${hours}:${minutes}`, dateObj: istTime };
}

/**
 * Resolves a clock time (e.g. "8pm", "8:30 am", "6") using Nearest-Future Rule (Rule 35).
 */
export function resolveNearestFutureTime(
  rawTimeStr: string,
  now: Date,
  explicitOffsetDays: number = 0
): { localDate: string; localTime: string } {
  const { dateIst, dateObj } = getNowIst(now);
  const currentHours = dateObj.getUTCHours();
  const currentMinutes = dateObj.getUTCMinutes();

  const trimmed = rawTimeStr.trim().toLowerCase();
  const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) {
    return { localDate: dateIst, localTime: "20:00" };
  }

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  } else if (!meridiem) {
    // Shorthand without am/pm (e.g. "at 6", "at 8")
    // Rule 35 Nearest Future: check if AM is still in future today
    if (explicitOffsetDays === 0) {
      const isAmFuture = hour > currentHours || (hour === currentHours && minute > currentMinutes);
      const pmHour = hour < 12 ? hour + 12 : hour;
      const isPmFuture = pmHour > currentHours || (pmHour === currentHours && minute > currentMinutes);

      if (hour >= 7 && hour <= 12 && isAmFuture) {
        // AM is still upcoming today
      } else if (isPmFuture) {
        hour = pmHour;
      } else {
        // Neither upcoming today, roll over to tomorrow nearest future
        explicitOffsetDays = 1;
      }
    }
  }

  const targetDateObj = new Date(dateObj);
  targetDateObj.setUTCDate(targetDateObj.getUTCDate() + explicitOffsetDays);
  const targetDateStr = targetDateObj.toISOString().slice(0, 10);
  const targetTimeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  return { localDate: targetDateStr, localTime: targetTimeStr };
}

/**
 * Deterministic parser for explicit reminder forms (A2).
 */
export function parseExplicitReminderDeterministic(
  text: string,
  now: Date = new Date(),
  profile?: any
): ParsedReminder | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Slash command /add <text>
  if (lower.startsWith("/add ")) {
    const content = trimmed.slice(5).trim();
    if (!content) return null;
    const { dateIst } = getNowIst(now);
    const eveningAnchor = profile?.evening_anchor_time || "20:00";
    const dueFormatted = formatConfirmationDate(dateIst, eveningAnchor);
    return {
      title: content,
      localDate: dateIst,
      localTime: eveningAnchor,
      dueAtFormatted: dueFormatted,
      remindAtFormatted: dueFormatted,
      dueDifferentFromRemind: false,
      anchor: "evening",
      confidence: 1.0,
    };
  }

  // 2. Relative offset: "remind me to <title> in <N> min(s)/hour(s)" or "remind me in <N> min(s) to <title>"
  const relRegex1 = /remind\s+(?:me\s+)?(?:to\s+|about\s+)?(.+?)\s+in\s+(\d+|one|two|three|five|ten|fifteen|twenty|thirty)\s+(min|mins|minute|minutes|hour|hours)\b/i;
  const relRegex2 = /remind\s+(?:me\s+)?in\s+(\d+|one|two|three|five|ten|fifteen|twenty|thirty)\s+(min|mins|minute|minutes|hour|hours)\s+(?:to\s+|about\s+)?(.+)/i;

  let relMatch = lower.match(relRegex1);
  let title = "";
  let numVal = 0;
  let unit = "";

  const wordToNum: Record<string, number> = {
    one: 1, two: 2, three: 3, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30,
  };

  if (relMatch) {
    title = relMatch[1].trim();
    numVal = wordToNum[relMatch[2]] || parseInt(relMatch[2], 10);
    unit = relMatch[3];
  } else {
    relMatch = lower.match(relRegex2);
    if (relMatch) {
      numVal = wordToNum[relMatch[1]] || parseInt(relMatch[1], 10);
      unit = relMatch[2];
      title = relMatch[3].trim();
    }
  }

  if (relMatch && title && !isNaN(numVal) && numVal > 0) {
    const multMs = unit.startsWith("hour") ? 60 * 60 * 1000 : 60 * 1000;
    const targetInstant = new Date(now.getTime() + numVal * multMs);
    const { dateIst, timeIst } = getNowIst(targetInstant);
    const formatted = formatConfirmationDate(dateIst, timeIst);

    // Capitalize first letter of title
    const cleanTitle = title.charAt(0).toUpperCase() + title.slice(1);
    return {
      title: cleanTitle,
      localDate: dateIst,
      localTime: timeIst,
      dueAtFormatted: formatted,
      remindAtFormatted: formatted,
      dueDifferentFromRemind: false,
      anchor: "none",
      confidence: 1.0,
    };
  }

  // 3. Anchor "by tonight" / "tonight"
  const tonightMatch = lower.match(/(?:submit|finish|complete|do|buy|prepare)\s+(.+?)\s+by\s+tonight/i) ||
                       lower.match(/remind\s+(?:me\s+)?(?:to\s+|about\s+)?(.+?)\s+(?:by\s+)?tonight/i);
  if (tonightMatch) {
    const rawTitle = tonightMatch[1].trim();
    const { dateIst } = getNowIst(now);
    const eveningTime = profile?.evening_anchor_time || "20:00";
    const dueFormatted = formatConfirmationDate(dateIst, eveningTime);
    // Remind at 7pm or 8pm
    const remindTime = "19:00";
    const remindFormatted = formatConfirmationDate(dateIst, remindTime);
    const cleanTitle = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
    return {
      title: cleanTitle,
      localDate: dateIst,
      localTime: eveningTime,
      dueAtFormatted: dueFormatted,
      remindAtFormatted: remindFormatted,
      dueDifferentFromRemind: true,
      anchor: "evening",
      confidence: 1.0,
    };
  }

  // 4. Regional day words (kal, repu, aaj, parso)
  const regDate = parseRegionalDateWords(lower);
  if (regDate.hasDayWord && regDate.offsetDays !== undefined && regDate.offsetDays >= 0) {
    // Check if task / assignment submission
    const cleanLower = lower.replace(/\b(kal|repu|aaj|parso|subah|shaam|raat|morning|evening|night)\b/gi, "").trim();
    const actionMatch = cleanLower.match(/(?:remind\s+(?:me\s+)?(?:to\s+|about\s+)?|submit\s+|karna\s+hai\s+|dena\s+hai\s+)?(.+?)(?:\s+(?:submit\s+)?karna\s+hai|\s+dena\s+hai|$)/i);
    let extractedTitle = actionMatch?.[1]?.trim() || "";
    extractedTitle = extractedTitle.replace(/^to\s+/i, "").replace(/^about\s+/i, "");

    if (extractedTitle.length > 2) {
      let anchorTime = regDate.anchor === "morning"
        ? (profile?.morning_anchor_time || "08:00")
        : (profile?.evening_anchor_time || "20:00");

      // Check if specific clock time was also mentioned (e.g. "5pm")
      const timeMatch = lower.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
      let targetDate = "";
      let targetTime = "";

      if (timeMatch && !timeMatch[1].includes(String(regDate.offsetDays))) {
        const resolved = resolveNearestFutureTime(timeMatch[1], now, regDate.offsetDays);
        targetDate = resolved.localDate;
        targetTime = resolved.localTime;
      } else {
        const { dateObj } = getNowIst(now);
        dateObj.setUTCDate(dateObj.getUTCDate() + regDate.offsetDays);
        targetDate = dateObj.toISOString().slice(0, 10);
        targetTime = anchorTime;
      }

      // Prettify title (e.g. "assignment submit" -> "Submit assignment")
      let finalTitle = extractedTitle;
      if (/assignment/i.test(extractedTitle) && /submit/i.test(lower)) {
        finalTitle = "Submit assignment";
      } else {
        finalTitle = finalTitle.charAt(0).toUpperCase() + finalTitle.slice(1);
      }

      const formatted = formatConfirmationDate(targetDate, targetTime);
      return {
        title: finalTitle,
        localDate: targetDate,
        localTime: targetTime,
        dueAtFormatted: formatted,
        remindAtFormatted: formatted,
        dueDifferentFromRemind: false,
        anchor: regDate.anchor || "none",
        confidence: 0.98,
      };
    }
  }

  // 5. Explicit "remind me to <title> at <time>" or "remind me at <time> to <title>"
  const atTimeRegex1 = /remind\s+(?:me\s+)?(?:to\s+|about\s+)?(.+?)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(today|tomorrow)?/i;
  const atTimeRegex2 = /remind\s+(?:me\s+)?at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(today|tomorrow)?\s+(?:to\s+|about\s+)?(.+)/i;
  const directActionRegex = /^(buy|call|meet|pick\s+up|submit|send)\s+(.+?)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(today|tomorrow)?/i;

  let matchAt = lower.match(atTimeRegex1);
  let timeStr = "";
  let dayWord = "";

  if (matchAt) {
    title = matchAt[1].trim();
    timeStr = matchAt[2];
    dayWord = matchAt[3] || "";
  } else {
    matchAt = lower.match(atTimeRegex2);
    if (matchAt) {
      timeStr = matchAt[1];
      dayWord = matchAt[2] || "";
      title = matchAt[3].trim();
    } else {
      matchAt = lower.match(directActionRegex);
      if (matchAt) {
        title = `${matchAt[1]} ${matchAt[2]}`.trim();
        timeStr = matchAt[3];
        dayWord = matchAt[4] || "";
      }
    }
  }

  if (matchAt && title && timeStr) {
    const offsetDays = dayWord === "tomorrow" ? 1 : 0;
    const resolved = resolveNearestFutureTime(timeStr, now, offsetDays);
    const cleanTitle = title.charAt(0).toUpperCase() + title.slice(1);
    const formatted = formatConfirmationDate(resolved.localDate, resolved.localTime);
    return {
      title: cleanTitle,
      localDate: resolved.localDate,
      localTime: resolved.localTime,
      dueAtFormatted: formatted,
      remindAtFormatted: formatted,
      dueDifferentFromRemind: false,
      anchor: "none",
      confidence: 1.0,
    };
  }

  // 6. "remind me to <title> tomorrow"
  const tomorrowMatch = lower.match(/remind\s+(?:me\s+)?(?:to\s+|about\s+)?(.+?)\s+tomorrow\b/i);
  if (tomorrowMatch) {
    const rawTitle = tomorrowMatch[1].trim();
    const { dateObj } = getNowIst(now);
    dateObj.setUTCDate(dateObj.getUTCDate() + 1);
    const targetDate = dateObj.toISOString().slice(0, 10);
    const morningTime = profile?.morning_anchor_time || "08:00";
    const cleanTitle = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
    const formatted = formatConfirmationDate(targetDate, morningTime);
    return {
      title: cleanTitle,
      localDate: targetDate,
      localTime: morningTime,
      dueAtFormatted: formatted,
      remindAtFormatted: formatted,
      dueDifferentFromRemind: false,
      anchor: "morning",
      confidence: 0.98,
    };
  }

  return null;
}

/**
 * Splits a compound message into at most 3 distinct clauses (A4).
 */
export function splitMessageClauses(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Patterns that delimit clauses:
  // 1. ", and " or ", also "
  // 2. ", " when followed by typical verbs or question words (e.g. ", buy milk")
  // 3. " and " / " also " when followed by typical verbs or question words
  // 4. "\n"
  // 5. "; "
  const delimiterRegex = /,\s*(?:and\s+|also\s+)?(?=(?:remind|buy|submit|call|meet|what|how|i\s+need|i\s+must|i\s+will)\b)|,\s*(?:and|also)\s+|\s+and\s+(?=(?:remind|buy|submit|call|meet|what|how|i\s+need|i\s+must|i\s+will)\b)|\s+also\s+|;\s*|\n+/i;

  const rawParts = trimmed.split(delimiterRegex);
  const clauses: string[] = [];
  for (const part of rawParts) {
    const s = part.trim();
    if (s.length > 0) {
      clauses.push(s);
    }
  }

  // Return at most 3 clauses
  return clauses.slice(0, 3);
}
