import workerEntry from "../worker/index";
import { createMockD1 } from "./mockD1";

const worker = workerEntry as any;
const backupToken = "backup-test-token-".padEnd(48, "x");

const env = {
  DB: createMockD1(),
  BACKUP_EXPORT_TOKEN: backupToken,
  TELEGRAM_OWNER_ID: "test-owner",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-not-for-backup",
  TELEGRAM_BOT_TOKEN: "mock-token",
  TEST_MODE: "true",
};

const cases = [
  {
    name: "Valid token: full JSON export",
    path: "/api/v1/export?format=json",
    token: backupToken,
    expected: 200,
    exportPayload: true,
  },
  {
    name: "Valid token: JSON export with omitted format",
    path: "/api/v1/export",
    token: backupToken,
    expected: 200,
    exportPayload: true,
  },
  {
    name: "Missing token: export denied",
    path: "/api/v1/export?format=json",
    token: "",
    expected: 401,
  },
  {
    name: "Invalid token: export denied",
    path: "/api/v1/export?format=json",
    token: "wrong-backup-token-that-is-long-enough",
    expected: 401,
  },
  {
    name: "Backup token cannot access tasks",
    path: "/api/v1/tasks",
    token: backupToken,
    expected: 401,
  },
  {
    name: "Backup token cannot request CSV",
    path: "/api/v1/export?format=csv",
    token: backupToken,
    expected: 401,
  },
  {
    name: "Backup token cannot request one entity",
    path: "/api/v1/export?format=json&entity=tasks",
    token: backupToken,
    expected: 401,
  },
  {
    name: "Backup token cannot add extra query parameters",
    path: "/api/v1/export?format=json&extra=1",
    token: backupToken,
    expected: 401,
  },
  {
    name: "Backup token cannot repeat the format parameter",
    path: "/api/v1/export?format=json&format=json",
    token: backupToken,
    expected: 401,
  },
];

let failures = 0;

for (const test of cases) {
  try {
    const headers: Record<string, string> = {};

    if (test.token) {
      headers.Authorization = `Bearer ${test.token}`;
    }

    const request = new Request(
      `https://personal-ai-os.local${test.path}`,
      { method: "GET", headers },
    );

    const response = await worker.fetch(request, env);
    let passed = response.status === test.expected;

    if (passed && test.exportPayload) {
      try {
        const body = await response.json() as any;
        passed =
          body?.ok === true &&
          body?.data?.counts !== undefined &&
          Array.isArray(body?.data?.data?.tasks);
      } catch {
        passed = false;
      }
    }

    console.log(
      `${passed ? "PASS" : "FAIL"}: ${test.name} ` +
      `(HTTP ${response.status}; expected ${test.expected})`,
    );

    if (!passed) failures++;
  } catch {
    console.log(`FAIL: ${test.name} (request threw an exception)`);
    failures++;
  }
}

console.log(`\nResult: ${cases.length - failures}/${cases.length} passed`);

if (failures > 0) {
  process.exitCode = 1;
}
