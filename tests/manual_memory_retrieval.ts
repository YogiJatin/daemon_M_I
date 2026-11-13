/**
 * tests/manual_memory_retrieval.ts - manual check of the REAL retrieval path.
 *
 * Runs worker/memoryService.ts#retrieveMemoriesForPrompt against the remote D1
 * database through a thin wrangler-CLI shim, so the scoring code that DAEMON
 * actually uses is exercised. Not part of `npm test` (it needs network + auth).
 *
 *   npx tsx tests/manual_memory_retrieval.ts
 */

import { execFileSync } from "node:child_process";
import { retrieveMemoriesForPrompt } from "../worker/memoryService";

const DB = "personal-ai-os-db";

function quote(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSql(sql: string, args: unknown[]): any[] {
  const parts = sql.split("?");
  let inlined = parts[0];
  for (let k = 1; k < parts.length; k++) inlined += quote(args[k - 1]) + parts[k];
  const out = execFileSync(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", DB, "--remote", "--json", "--command", inlined],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const startIdx = out.indexOf("[");
  const parsed = JSON.parse(out.slice(startIdx));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first?.results || []) as any[];
}

const shim = {
  prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        return { all: async () => ({ results: runSql(sql, args) }), run: async () => ({ success: true }) };
      },
      all: async () => ({ results: runSql(sql, []) }),
      run: async () => ({ success: true }),
    };
  },
} as any;

const QUERIES: Array<[string, string]> = [
  ["who am i", "identity or education"],
  ["my timetable this week", "CSM-A timetable"],
  ["what is VeilAi", "VeilAi project"],
  ["what is DISSECT", "DISSECT completed"],
  ["is DAEMON-Suite still active", "DAEMON-Suite discontinued"],
  ["which GSoC organisation should I target", "GSoC provisional ranking"],
  ["do I have a laptop at college", "laptop available / schedule"],
  ["quiet hours", "adaptive quiet hours"],
  ["what is AstraTrace", "AstraTrace SIH"],
  ["does task creation need approval", "task approval rule"],
];

let hits = 0;
console.log("query | retrieved ids | expected");
console.log("---|---|---");
for (const [query, expected] of QUERIES) {
  const res = await retrieveMemoriesForPrompt(shim as any, query, new Date("2026-11-13T12:00:00Z"), 5, 1200);
  const ids = res.injectedIds || [];
  if (ids.length > 0) hits++;
  console.log(`${query} | ${ids.join(", ") || "(none)"} | ${expected}`);
}
console.log(`\n${hits}/${QUERIES.length} queries returned at least one record`);
if (hits < QUERIES.length) process.exitCode = 1;
