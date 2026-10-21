import {
  getIsoWeekday,
  getAlternatingWeekType,
  getMondayOfWeek,
  addDaysYmd,
} from "../worker/recurrenceEngine";
import { getISTDateParts, istToUtcDate } from "../worker/dateParser";

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

console.log("\n=== RUNNING BLOCK 3B UNIT TESTS ===\n");

// 1. Weekday mappings
console.log("--- Test: Weekday & Monday Math ---");
assert(getIsoWeekday("2026-10-19") === 1, "2026-10-19 is Monday (1)");
assert(getIsoWeekday("2026-10-20") === 2, "2026-10-20 is Tuesday (2)");
assert(getIsoWeekday("2026-10-25") === 7, "2026-10-25 is Sunday (7)");
assert(getMondayOfWeek("2026-10-21") === "2026-10-19", "Monday of 2026-10-21 (Wed) is 2026-10-19");
assert(getMondayOfWeek("2026-10-25") === "2026-10-19", "Monday of 2026-10-25 (Sun) is 2026-10-19");

// 2. Alternating A/B weeks
console.log("\n--- Test: Alternating Weeks from Anchor Monday ---");
const anchorMon = "2026-10-19";
assert(getAlternatingWeekType("2026-10-19", anchorMon) === "A", "Week of 2026-10-19 is Week A");
assert(getAlternatingWeekType("2026-10-21", anchorMon) === "A", "Wednesday in week of 2026-10-19 is Week A");
assert(getAlternatingWeekType("2026-10-26", anchorMon) === "B", "Week of 2026-10-26 is Week B");
assert(getAlternatingWeekType("2026-10-28", anchorMon) === "B", "Wednesday in week of 2026-10-26 is Week B");
assert(getAlternatingWeekType("2026-11-02", anchorMon) === "A", "Week of 2026-11-02 is Week A");
assert(getAlternatingWeekType("2026-11-09", anchorMon) === "B", "Week of 2026-11-09 is Week B");

// 3. IST Boundary & Preparation Offset Calculation
console.log("\n--- Test: IST Boundaries & Preparation Offsets ---");
// Class at 09:00 IST on 2026-10-20 with 45 min prep -> prep at 08:15 IST
const classDate = "2026-10-20";
const classStart = "09:00";
const classInstant = istToUtcDate(classDate, classStart);
const prepLeadMinutes = 45;
const prepInstant = new Date(classInstant.getTime() - prepLeadMinutes * 60 * 1000);
const prepIST = getISTDateParts(prepInstant);

assert(prepIST.localDate === "2026-10-20", "Prep date remains 2026-10-20 in IST");
assert(prepIST.localTime === "08:15", "Prep time is exactly 08:15 IST (45m before 09:00)");

// Prep reminder for morning class at 07:00 with 45 min lead -> 06:15 IST (inside quiet hours 22:00-06:30!)
const earlyClass = istToUtcDate("2026-10-20", "07:00");
const earlyPrep = new Date(earlyClass.getTime() - 45 * 60 * 1000);
const earlyPrepIST = getISTDateParts(earlyPrep);
assert(earlyPrepIST.localTime === "06:15", "Early class at 07:00 calculates prep at 06:15 IST");

console.log(`\n========================================`);
console.log(`TOTAL: ${passCount + failCount} | PASSED: ${passCount} | FAILED: ${failCount}`);
console.log(`========================================\n`);

if (failCount > 0) {
  process.exit(1);
}
