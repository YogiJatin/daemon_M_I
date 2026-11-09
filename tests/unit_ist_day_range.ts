/**
 * tests/unit_ist_day_range.ts - the IST day window that reminders and "today" counts use.
 *
 * getISTDayRange is what the scheduler and attention budget treat as "today". It was the
 * last place doing hand-written +05:30 arithmetic, so it gets pinned here: IST days start
 * at 18:30 UTC of the previous calendar day, including across a year boundary.
 */

import { getISTDayRange } from "../worker/attention";

let pass = 0;
let fail = 0;

function assert(condition: boolean, name: string, detail?: unknown): void {
  if (condition) {
    pass += 1;
    console.log(`  PASS: ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
  }
}

console.log("\n=== IST DAY RANGE ===\n");

const cases: Array<{ iso: string; localDate: string; startIso: string; label: string }> = [
  { iso: "2026-11-09T02:00:00Z", localDate: "2026-11-09", startIso: "2026-11-08T18:30:00.000Z", label: "07:30 IST is today" },
  { iso: "2026-11-09T18:29:59Z", localDate: "2026-11-09", startIso: "2026-11-08T18:30:00.000Z", label: "23:59:59 IST is still today" },
  { iso: "2026-11-09T18:30:00Z", localDate: "2026-11-10", startIso: "2026-11-09T18:30:00.000Z", label: "00:00 IST rolls to the next day" },
  { iso: "2026-01-01T00:00:00Z", localDate: "2026-01-01", startIso: "2025-12-31T18:30:00.000Z", label: "year boundary keeps the offset" },
];

for (const testCase of cases) {
  const range = getISTDayRange(new Date(testCase.iso));
  assert(range.localDate === testCase.localDate, `${testCase.label}: localDate`, range.localDate);
  assert(range.startIso === testCase.startIso, `${testCase.label}: startIso`, range.startIso);
  assert(
    new Date(range.endIso).getTime() - new Date(range.startIso).getTime() === 24 * 3600 * 1000,
    `${testCase.label}: the window is exactly 24h`
  );
}

console.log(`\nTOTAL: ${pass + fail} | PASSED: ${pass} | FAILED: ${fail}`);
if (fail > 0) process.exit(1);
