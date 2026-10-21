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
  // IST is UTC+05:30
  return new Date(`${localDate}T${localTime}:00+05:30`);
}

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export function parseDateShorthand(raw: string, now: Date = new Date()): ParseDateResult {
  const input = raw.trim().toLowerCase();

  // 1. no-date
  if (input === "" || input === "no-date") {
    return {
      success: true,
      deadline: {
        kind: "none",
        localDate: null,
        localTime: null,
        utcInstant: null,
      },
    };
  }

  const currentIST = getISTDateParts(now);

  // 2. today
  if (input === "today") {
    return {
      success: true,
      deadline: {
        kind: "date_only",
        localDate: currentIST.localDate,
        localTime: null,
        utcInstant: null,
      },
    };
  }

  // 3. tomorrow
  if (input === "tomorrow") {
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowIST = getISTDateParts(tomorrowDate);
    return {
      success: true,
      deadline: {
        kind: "date_only",
        localDate: tomorrowIST.localDate,
        localTime: null,
        utcInstant: null,
      },
    };
  }

  // 4. Weekday names (nearest strictly future occurrence)
  if (input in WEEKDAY_MAP) {
    const targetDay = WEEKDAY_MAP[input];
    let daysToAdd = (targetDay - currentIST.dayOfWeek + 7) % 7;
    if (daysToAdd === 0) {
      daysToAdd = 7; // strictly after current local date
    }
    const targetDate = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    const targetIST = getISTDateParts(targetDate);
    return {
      success: true,
      deadline: {
        kind: "date_only",
        localDate: targetIST.localDate,
        localTime: null,
        utcInstant: null,
      },
    };
  }

  // 5. +Nh relative offset
  const relativeMatch = input.match(/^\+(\d+)h$/);
  if (relativeMatch) {
    const hours = parseInt(relativeMatch[1], 10);
    const targetInstant = new Date(now.getTime() + hours * 60 * 60 * 1000);
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

  // 6. Time today: HH:mm (e.g. 18:00)
  const timeOnlyMatch = input.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnlyMatch) {
    const hours = timeOnlyMatch[1].padStart(2, "0");
    const minutes = timeOnlyMatch[2];
    const targetDate = istToUtcDate(currentIST.localDate, `${hours}:${minutes}`);

    if (targetDate.getTime() <= now.getTime()) {
      return {
        success: false,
        error: `Time '${raw}' has already passed for today. Did you mean tomorrow or another date?`,
      };
    }

    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: currentIST.localDate,
        localTime: `${hours}:${minutes}`,
        utcInstant: targetDate.toISOString(),
      },
    };
  }

  // 7. Tomorrow with time: tomorrow HH:mm (e.g. tomorrow 18:00)
  const tomorrowTimeMatch = input.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/);
  if (tomorrowTimeMatch) {
    const hours = tomorrowTimeMatch[1].padStart(2, "0");
    const minutes = tomorrowTimeMatch[2];
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowIST = getISTDateParts(tomorrowDate);
    const targetDate = istToUtcDate(tomorrowIST.localDate, `${hours}:${minutes}`);

    return {
      success: true,
      deadline: {
        kind: "timed",
        localDate: tomorrowIST.localDate,
        localTime: `${hours}:${minutes}`,
        utcInstant: targetDate.toISOString(),
      },
    };
  }

  // 8. Explicit YYYY-MM-DD HH:mm
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

  // 9. Explicit date only: YYYY-MM-DD
  const explicitDateMatch = input.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (explicitDateMatch) {
    const dateStr = explicitDateMatch[1];
    return {
      success: true,
      deadline: {
        kind: "date_only",
        localDate: dateStr,
        localTime: null,
        utcInstant: null,
      },
    };
  }

  return {
    success: false,
    error: `Unrecognized date format '${raw}'. Supported formats: today, tomorrow, weekday (e.g. fri), 18:00, tomorrow 18:00, +2h, YYYY-MM-DD HH:mm, or no-date.`,
  };
}
