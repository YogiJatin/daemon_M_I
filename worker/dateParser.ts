export type DeadlineKind = "none" | "date_only" | "timed";

export interface ParsedDeadline {
  kind: DeadlineKind;
  localDate: string | null;
  localTime: string | null;
  utcInstant: string | null;
}

export interface ParseDateResult {
  success: boolean;
  deadline?: ParsedDeadline;
  error?: string;
}

export interface ExtractedTaskInput {
  title: string;
  deadline: ParsedDeadline;
  hasTimePhrase: boolean;
  rawTimePhrase?: string;
  parseError?: string;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function getISTDateParts(date: Date) {
  const istTime = new Date(date.getTime() + IST_OFFSET_MS);
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(istTime.getUTCDate()).padStart(2, "0");
  const hours = String(istTime.getUTCHours()).padStart(2, "0");
  const minutes = String(istTime.getUTCMinutes()).padStart(2, "0");
  const dayOfWeek = istTime.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  return {
    year,
    month,
    day,
    hours,
    minutes,
    dayOfWeek,
    localDate: `${year}-${month}-${day}`,
    localTime: `${hours}:${minutes}`,
  };
}

export function istToUtcDate(localDate: string, localTime: string): Date {
  return new Date(`${localDate}T${localTime}:00+05:30`);
}

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60,
};

export function parseNumberWord(str: string): number | null {
  const s = str.toLowerCase().trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (NUMBER_WORDS[s] !== undefined) return NUMBER_WORDS[s];
  const parts = s.split(/[-\s]+/);
  if (parts.length === 2 && NUMBER_WORDS[parts[0]] && NUMBER_WORDS[parts[1]]) {
    return NUMBER_WORDS[parts[0]] + NUMBER_WORDS[parts[1]];
  }
  return null;
}

export function parseTimeOfDay(timeStr: string): { hours: string; minutes: string } | null {
  const m = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const isAmPm = !!m[3];
  const ampm = m[3] ? m[3].toLowerCase() : null;
  const mins = m[2] !== undefined ? m[2] : (isAmPm ? "00" : null);
  if (mins === null) return null;
  const minNum = parseInt(mins, 10);
  if (minNum < 0 || minNum > 59) return null;

  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
  } else {
    if (h < 0 || h > 23) return null;
  }
  return { hours: String(h).padStart(2, "0"), minutes: String(minNum).padStart(2, "0") };
}

export function parseRelativeDuration(raw: string, now: Date = new Date()): ParseDateResult | null {
  const trimmed = raw.trim();
  // Support "+2h", "+15m"
  const relShort = trimmed.match(/^\+(\d+)\s*([a-z]+)?$/i);
  if (relShort) {
    const val = parseInt(relShort[1], 10);
    const unit = (relShort[2] || "h").toLowerCase();
    let ms = val * 60 * 60 * 1000;
    if (unit.startsWith("m")) ms = val * 60 * 1000;
    else if (unit.startsWith("s")) ms = val * 1000;
    else if (unit.startsWith("d")) ms = val * 24 * 60 * 60 * 1000;
    const targetInstant = new Date(now.getTime() + ms);
    const targetIST = getISTDateParts(targetInstant);
    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: targetIST.localDate,
        localTime: targetIST.localTime,
        utcInstant: targetInstant.toISOString(),
      },
    };
  }

  // Support "in 1 minute", "in one minute", "in 10 minutes", "in an hour", "after 2 hours", "after two hours"
  const relLong = trimmed.match(/^(?:in|after)\s+([a-z0-9-]+(?:\s+[a-z0-9-]+)?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|d|h|m|s)$/i);
  if (relLong) {
    const num = parseNumberWord(relLong[1]);
    if (num === null || isNaN(num) || num <= 0) return null;
    const unit = relLong[2].toLowerCase();
    let ms = 0;
    if (/^(s|secs?|seconds?)$/.test(unit)) ms = num * 1000;
    else if (/^(m|mins?|minutes?)$/.test(unit)) ms = num * 60 * 1000;
    else if (/^(h|hrs?|hours?)$/.test(unit)) ms = num * 60 * 60 * 1000;
    else if (/^(d|days?)$/.test(unit)) ms = num * 24 * 60 * 60 * 1000;
    const targetInstant = new Date(now.getTime() + ms);
    const targetIST = getISTDateParts(targetInstant);
    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: targetIST.localDate,
        localTime: targetIST.localTime,
        utcInstant: targetInstant.toISOString(),
      },
    };
  }
  return null;
}

export function parseDateShorthand(raw: string, now: Date = new Date()): ParseDateResult {
  const input = raw.trim().toLowerCase();

  // 1. no-date
  if (input === "" || input === "no-date") {
    return {
      success: true,
      deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
    };
  }

  // 2. Relative duration ("in 1 minute", "in an hour", "after 2 hours", "+2h")
  const rel = parseRelativeDuration(input, now);
  if (rel) return rel;

  const currentIST = getISTDateParts(now);

  // 3. "today" with time: "today 13:25", "today at 13:25", "today 1:25pm"
  const todayTimeMatch = input.match(/^today(?:\s+at)?\s+(.+)$/i);
  if (todayTimeMatch) {
    const parsedTime = parseTimeOfDay(todayTimeMatch[1]);
    if (!parsedTime) {
      return { success: false, error: `Invalid time format in '${raw}'. Example: 'today 13:25' or 'today 5pm'` };
    }
    const targetDate = istToUtcDate(currentIST.localDate, `${parsedTime.hours}:${parsedTime.minutes}`);
    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: currentIST.localDate,
        localTime: `${parsedTime.hours}:${parsedTime.minutes}`,
        utcInstant: targetDate.toISOString(),
      },
    };
  }

  // 4. "today" date only
  if (input === "today") {
    return {
      success: true,
      deadline: { kind: "date_only", localDate: currentIST.localDate, localTime: null, utcInstant: null },
    };
  }

  // 5. "tomorrow" with time: "tomorrow 13:25", "tomorrow at 13:25", "tomorrow 9am"
  const tomorrowTimeMatch = input.match(/^tomorrow(?:\s+at)?\s+(.+)$/i);
  if (tomorrowTimeMatch) {
    const parsedTime = parseTimeOfDay(tomorrowTimeMatch[1]);
    if (!parsedTime) {
      return { success: false, error: `Invalid time format in '${raw}'. Example: 'tomorrow 10:00' or 'tomorrow 9am'` };
    }
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowIST = getISTDateParts(tomorrowDate);
    const targetDate = istToUtcDate(tomorrowIST.localDate, `${parsedTime.hours}:${parsedTime.minutes}`);
    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: tomorrowIST.localDate,
        localTime: `${parsedTime.hours}:${parsedTime.minutes}`,
        utcInstant: targetDate.toISOString(),
      },
    };
  }

  // 6. "tomorrow" date only
  if (input === "tomorrow") {
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowIST = getISTDateParts(tomorrowDate);
    return {
      success: true,
      deadline: { kind: "date_only", localDate: tomorrowIST.localDate, localTime: null, utcInstant: null },
    };
  }

  // 7. Weekday names (fri, monday)
  if (input in WEEKDAY_MAP) {
    const targetDay = WEEKDAY_MAP[input];
    let daysToAdd = (targetDay - currentIST.dayOfWeek + 7) % 7;
    if (daysToAdd === 0) daysToAdd = 7;
    const targetDate = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    const targetIST = getISTDateParts(targetDate);
    return {
      success: true,
      deadline: { kind: "date_only", localDate: targetIST.localDate, localTime: null, utcInstant: null },
    };
  }

  // 8. Time today without prefix: "13:25", "at 13:25", "18:00", "5pm"
  const timeOnlyClean = input.replace(/^at\s+/i, "");
  const timeOnlyParsed = parseTimeOfDay(timeOnlyClean);
  if (timeOnlyParsed) {
    const targetDate = istToUtcDate(currentIST.localDate, `${timeOnlyParsed.hours}:${timeOnlyParsed.minutes}`);
    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: currentIST.localDate,
        localTime: `${timeOnlyParsed.hours}:${timeOnlyParsed.minutes}`,
        utcInstant: targetDate.toISOString(),
      },
    };
  }

  // 9. Explicit YYYY-MM-DD HH:mm
  const explicitDateTimeMatch = input.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (explicitDateTimeMatch) {
    const dateStr = explicitDateTimeMatch[1];
    const hours = explicitDateTimeMatch[2].padStart(2, "0");
    const minutes = explicitDateTimeMatch[3];
    const targetDate = istToUtcDate(dateStr, `${hours}:${minutes}`);
    if (isNaN(targetDate.getTime())) {
      return { success: false, error: `Invalid date/time: '${raw}'` };
    }
    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: dateStr,
        localTime: `${hours}:${minutes}`,
        utcInstant: targetDate.toISOString(),
      },
    };
  }

  // 10. Explicit date only: YYYY-MM-DD
  const explicitDateMatch = input.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (explicitDateMatch) {
    return {
      success: true,
      deadline: { kind: "date_only", localDate: explicitDateMatch[1], localTime: null, utcInstant: null },
    };
  }

  return {
    success: false,
    error: `Unrecognized date format '${raw}'. Supported formats: today, tomorrow, today 13:25, tomorrow 10:00, in 10 minutes, in an hour, after 2 hours, weekday (e.g. fri), 18:00, YYYY-MM-DD HH:mm, or no-date.`,
  };
}

export function extractTimeAndTitle(raw: string, now: Date = new Date()): ExtractedTaskInput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      title: "",
      deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
      hasTimePhrase: false,
    };
  }

  // 1. Explicit pipe syntax: "<datePart> | <titlePart>"
  if (trimmed.includes("|")) {
    const pipeIdx = trimmed.indexOf("|");
    const datePart = trimmed.slice(0, pipeIdx).trim();
    const titlePart = trimmed.slice(pipeIdx + 1).trim();
    const res = parseDateShorthand(datePart, now);
    if (res.success && res.deadline) {
      return {
        title: titlePart,
        deadline: res.deadline,
        hasTimePhrase: true,
        rawTimePhrase: datePart,
      };
    }
    return {
      title: titlePart,
      deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
      hasTimePhrase: true,
      parseError: res.error || `Invalid time phrase '${datePart}'`,
      rawTimePhrase: datePart,
    };
  }

  // 2. Relative duration anywhere (e.g. "in 2 minutes test" or "test in 2 minutes")
  const relMatch = trimmed.match(/\b(in|after)\s+([a-z0-9-]+(?:\s+[a-z0-9-]+)?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i);
  if (relMatch) {
    const timePhrase = relMatch[0];
    const strippedTitle = trimmed.replace(timePhrase, "").replace(/\s+/g, " ").trim();
    const res = parseDateShorthand(timePhrase, now);
    if (res.success && res.deadline) {
      return {
        title: strippedTitle || "Untitled Task",
        deadline: res.deadline,
        hasTimePhrase: true,
        rawTimePhrase: timePhrase,
      };
    }
    return {
      title: strippedTitle || trimmed,
      deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
      hasTimePhrase: true,
      parseError: res.error,
      rawTimePhrase: timePhrase,
    };
  }

  // 3. "today [at] <time>" anywhere
  const todayMatch = trimmed.match(/\btoday(?:\s+at)?\s+(\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)\b/i);
  if (todayMatch) {
    const timePhrase = todayMatch[0];
    const strippedTitle = trimmed.replace(timePhrase, "").replace(/\s+/g, " ").trim();
    const res = parseDateShorthand(timePhrase, now);
    if (res.success && res.deadline) {
      return {
        title: strippedTitle || "Untitled Task",
        deadline: res.deadline,
        hasTimePhrase: true,
        rawTimePhrase: timePhrase,
      };
    }
    return {
      title: strippedTitle || trimmed,
      deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
      hasTimePhrase: true,
      parseError: res.error,
      rawTimePhrase: timePhrase,
    };
  }

  // 4. "tomorrow [at] <time>" anywhere
  const tomorrowMatch = trimmed.match(/\btomorrow(?:\s+at)?\s+(\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)\b/i);
  if (tomorrowMatch) {
    const timePhrase = tomorrowMatch[0];
    const strippedTitle = trimmed.replace(timePhrase, "").replace(/\s+/g, " ").trim();
    const res = parseDateShorthand(timePhrase, now);
    if (res.success && res.deadline) {
      return {
        title: strippedTitle || "Untitled Task",
        deadline: res.deadline,
        hasTimePhrase: true,
        rawTimePhrase: timePhrase,
      };
    }
    return {
      title: strippedTitle || trimmed,
      deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
      hasTimePhrase: true,
      parseError: res.error,
      rawTimePhrase: timePhrase,
    };
  }

  // 5. Standalone time at end of string (e.g. "meeting at 18:00" or "meeting 18:00" or "meeting 5pm")
  const atEndMatch = trimmed.match(/(?:\s+(?:at\s+)?(\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m))$/i);
  if (atEndMatch) {
    const timePhrase = atEndMatch[0].trim();
    const strippedTitle = trimmed.slice(0, trimmed.length - atEndMatch[0].length).trim();
    const res = parseDateShorthand(timePhrase, now);
    if (res.success && res.deadline) {
      return {
        title: strippedTitle || "Untitled Task",
        deadline: res.deadline,
        hasTimePhrase: true,
        rawTimePhrase: timePhrase,
      };
    }
  }

  // 6. Standalone "today" or "tomorrow" as word boundary
  const dayMatch = trimmed.match(/\b(today|tomorrow)\b/i);
  if (dayMatch) {
    const timePhrase = dayMatch[0];
    const strippedTitle = trimmed.replace(new RegExp(`\\b${timePhrase}\\b`, "i"), "").replace(/\s+/g, " ").trim();
    const res = parseDateShorthand(timePhrase, now);
    if (res.success && res.deadline) {
      return {
        title: strippedTitle || "Untitled Task",
        deadline: res.deadline,
        hasTimePhrase: true,
        rawTimePhrase: timePhrase,
      };
    }
  }

  // 7. Malformed time intent check (e.g. "today 25:99", "tomorrow 99:99", "in 5 widgets")
  const timeIntent = /\b(today|tomorrow|at\s+\d+|in\s+\d+|after\s+\d+)\b/i.test(trimmed);
  if (timeIntent) {
    return {
      title: trimmed,
      deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
      hasTimePhrase: true,
      parseError: "Unrecognized or invalid time format",
      rawTimePhrase: trimmed,
    };
  }

  // 8. Plain title with no time phrase
  return {
    title: trimmed,
    deadline: { kind: "none", localDate: null, localTime: null, utcInstant: null },
    hasTimePhrase: false,
  };
}
