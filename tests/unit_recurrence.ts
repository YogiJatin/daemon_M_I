import {
  calculateNextOccurrenceDates,
  parseRecurrenceShorthand,
  getAlternatingWeekType,
  getIsoWeekday,
  getMondayOfWeek,
  getDaysInMonth,
} from "../worker/recurrenceEngine";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, name: string, details?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${name}`, details ? JSON.stringify(details, null, 2) : "");
    failCount++;
  }
}

console.log("\n=== RUNNING BLOCK 3A UNIT TESTS ===\n");

// ----------------------------------------------------
// 1. TEST-3A.1: Daily, Weekly, Selected Weekdays
// ----------------------------------------------------
console.log("--- TEST-3A.1: Basic Recurrence Patterns ---");

// Daily (interval=1)
const daily1 = calculateNextOccurrenceDates(
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
assert(
  JSON.stringify(daily1) === JSON.stringify(["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]),
  "Daily recurrence (interval=1) generates consecutive days",
  { daily1 }
);

// Daily (interval=2)
const daily2 = calculateNextOccurrenceDates(
  {
    pattern: "daily",
    interval: 2,
    weekdays_json: null,
    month_day: null,
    year_month: null,
    start_date: "2026-10-21",
    end_date: null,
    week_anchor_monday: null,
  },
  "2026-10-21",
  "2026-10-27"
);
assert(
  JSON.stringify(daily2) === JSON.stringify(["2026-10-21", "2026-10-23", "2026-10-25", "2026-10-27"]),
  "Every 2 days recurrence skips alternate days",
  { daily2 }
);

// Weekly (interval=1, Friday=5)
const weeklyFri = calculateNextOccurrenceDates(
  {
    pattern: "weekly",
    interval: 1,
    weekdays_json: JSON.stringify([5]),
    month_day: null,
    year_month: null,
    start_date: "2026-10-21", // Wednesday
    end_date: null,
    week_anchor_monday: null,
  },
  "2026-10-21",
  "2026-11-06"
);
assert(
  JSON.stringify(weeklyFri) === JSON.stringify(["2026-10-23", "2026-10-30", "2026-11-06"]),
  "Weekly Friday generates Fridays only",
  { weeklyFri }
);

// Selected weekdays (Mon=1, Wed=3, Fri=5)
const mwf = calculateNextOccurrenceDates(
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
assert(
  JSON.stringify(mwf) === JSON.stringify(["2026-10-21", "2026-10-23", "2026-10-26", "2026-10-28"]),
  "Selected weekdays (Mon, Wed, Fri) generates correct sequence",
  { mwf }
);

// ----------------------------------------------------
// 2. TEST-3A.2: Alternating A/B Weeks
// ----------------------------------------------------
console.log("\n--- TEST-3A.2: Alternating A/B Weeks ---");
const anchorMonday = "2026-10-19";

const altA = calculateNextOccurrenceDates(
  {
    pattern: "alternate_week_a",
    interval: 1,
    weekdays_json: JSON.stringify([1]), // Monday
    month_day: null,
    year_month: null,
    start_date: "2026-10-19",
    end_date: null,
    week_anchor_monday: anchorMonday,
  },
  "2026-10-19",
  "2026-11-10"
);
assert(
  JSON.stringify(altA) === JSON.stringify(["2026-10-19", "2026-11-02"]),
  "Week A produces Week A dates (2026-10-19, 2026-11-02) and skips Week B",
  { altA }
);

const altB = calculateNextOccurrenceDates(
  {
    pattern: "alternate_week_b",
    interval: 1,
    weekdays_json: JSON.stringify([1]), // Monday
    month_day: null,
    year_month: null,
    start_date: "2026-10-19",
    end_date: null,
    week_anchor_monday: anchorMonday,
  },
  "2026-10-19",
  "2026-11-10"
);
assert(
  JSON.stringify(altB) === JSON.stringify(["2026-10-26", "2026-11-09"]),
  "Week B produces Week B dates (2026-10-26, 2026-11-09) and skips Week A",
  { altB }
);

// ----------------------------------------------------
// 3. Monthly Clamping and Leap Year
// ----------------------------------------------------
console.log("\n--- Monthly Clamping & Leap Year ---");

// Day 31: Jan 31 -> Feb 28 -> Mar 31
const month31 = calculateNextOccurrenceDates(
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
assert(
  JSON.stringify(month31) === JSON.stringify(["2026-01-31", "2026-02-28", "2026-03-31"]),
  "Month-end day 31 clamps to Feb 28 and restores to Mar 31 without drift",
  { month31 }
);

// Last day (-1): Jan 31 -> Feb 28 -> Mar 31 -> Apr 30
const lastDay = calculateNextOccurrenceDates(
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
  "2026-04-30"
);
assert(
  JSON.stringify(lastDay) === JSON.stringify(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]),
  "Last day of month (-1) calculates each month's actual last day",
  { lastDay }
);

// Yearly Feb 29 (Leap year safe: 2026 -> 28 Feb, 2027 -> 28 Feb, 2028 -> 29 Feb)
const leapYear = calculateNextOccurrenceDates(
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
assert(
  JSON.stringify(leapYear) === JSON.stringify(["2026-02-28", "2027-02-28", "2028-02-29"]),
  "Yearly Feb 29 clamps to Feb 28 on non-leap years and preserves Feb 29 on leap year (2028)",
  { leapYear }
);

// ----------------------------------------------------
// 4. Shorthand Recurrence Parser Tests
// ----------------------------------------------------
console.log("\n--- Shorthand Recurrence Parser ---");
const testNow = new Date("2026-10-21T06:00:00.000Z"); // Wed

const parserCases = [
  { input: "every day", pattern: "daily", interval: 1 },
  { input: "every 2 days", pattern: "daily", interval: 2 },
  { input: "every week", pattern: "weekly", interval: 1 },
  { input: "every 3 weeks", pattern: "weekly", interval: 3 },
  { input: "every month", pattern: "monthly", interval: 1 },
  { input: "every 2 months", pattern: "monthly", interval: 2 },
  { input: "every year", pattern: "yearly", interval: 1 },
  { input: "every monday", pattern: "selected_weekdays", weekdays: [1] },
  { input: "every monday 18:00", pattern: "selected_weekdays", weekdays: [1], time: "18:00" },
  { input: "every friday 09:00", pattern: "selected_weekdays", weekdays: [5], time: "09:00" },
  { input: "1st day of month", pattern: "monthly", monthDay: 1 },
  { input: "15th day of month", pattern: "monthly", monthDay: 15 },
  { input: "last day of month", pattern: "monthly", monthDay: -1 },
  { input: "every Jan 1", pattern: "yearly", yearMonth: 1, monthDay: 1 },
  { input: "every Dec 25", pattern: "yearly", yearMonth: 12, monthDay: 25 },
  { input: "alternate week a", pattern: "alternate_week_a" },
  { input: "alternate week b", pattern: "alternate_week_b" },
];

for (const c of parserCases) {
  const res = parseRecurrenceShorthand(c.input, testNow);
  const ok =
    res.isRecurrence &&
    res.ruleInput?.pattern === c.pattern &&
    (c.interval === undefined || res.ruleInput?.interval === c.interval) &&
    (c.time === undefined || res.ruleInput?.local_time === c.time) &&
    (c.monthDay === undefined || res.ruleInput?.month_day === c.monthDay) &&
    (c.yearMonth === undefined || res.ruleInput?.year_month === c.yearMonth);

  assert(ok, `Parser matches '${c.input}' -> ${c.pattern}`, { input: c.input, parsed: res.ruleInput });
}

// Check non-recurrence fallbacks
const nonRec1 = parseRecurrenceShorthand("tomorrow", testNow);
assert(!nonRec1.isRecurrence, "'tomorrow' correctly identified as non-recurrence");

const nonRec2 = parseRecurrenceShorthand("2026-11-01 18:00", testNow);
assert(!nonRec2.isRecurrence, "'2026-11-01 18:00' correctly identified as non-recurrence");

console.log(`\n========================================`);
console.log(`TOTAL: ${passCount + failCount} | PASSED: ${passCount} | FAILED: ${failCount}`);
console.log(`========================================\n`);

if (failCount > 0) {
  process.exit(1);
}
