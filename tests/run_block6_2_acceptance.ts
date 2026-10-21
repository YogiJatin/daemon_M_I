/**
 * tests/run_block6_2_acceptance.ts
 *
 * Live Acceptance Test Battery for Block 6.2:
 * - TEST-6.2.1: Audit Ledger O(1) Head Retrieval (/api/v1/audit/latest)
 * - TEST-6.2.2: Event Ingress on Business Operations (Task creation & completion ledger append)
 * - TEST-6.2.3: Forensic Entity Replay (/api/v1/audit/entity/:type/:id)
 * - TEST-6.2.4: Cryptographic Chain Verification (/api/v1/audit/verify -> VALID)
 * - TEST-6.2.5: Signed JSON Export with Manifest & Checksum Validation (/api/v1/audit/export)
 * - TEST-6.2.6: System Portability Export includes audit_chain (/api/v1/export)
 * - TEST-6.2.7: Rule 5 Zero Audit/Blockchain in Scheduler Invariant
 */

import { canonicalizeJson } from "../worker/auditSerializer";
import { sha256Hex } from "../worker/auditHasher";
import * as fs from "fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "local-test-webhook-secret";
const OWNER_ID = "8364430714";

interface TestStats {
  passed: number;
  failed: number;
}

const stats: TestStats = { passed: 0, failed: 0 };

function record(condition: boolean, name: string, details?: any) {
  if (condition) {
    console.log(`✅ PASS: ${name}`);
    stats.passed++;
  } else {
    console.error(`❌ FAIL: ${name}`, details ? JSON.stringify(details, null, 2) : "");
    stats.failed++;
  }
}

async function api(path: string, options: RequestInit = {}, sessionToken?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  } else {
    headers["X-Telegram-Bot-Api-Secret-Token"] = SECRET;
  }
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

async function sendTelegramCommand(cmd: string): Promise<any> {
  const payload = {
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: { id: Number(OWNER_ID), is_bot: false, first_name: "Owner" },
      chat: { id: Number(OWNER_ID), type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: cmd,
    },
  };

  const res = await fetch(`${BASE_URL}/api/v1/telegram/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function runAcceptanceBattery() {
  console.log("\n========================================================");
  console.log("   RUNNING BLOCK 6.2 LIVE ACCEPTANCE TEST BATTERY");
  console.log("========================================================\n");

  // ----------------------------------------------------
  // 1. Authenticate session via /pair
  // ----------------------------------------------------
  console.log("--- 1. Authenticating Session ---");
  const pairCmdRes = await sendTelegramCommand("/pair");
  const replyText = pairCmdRes.body.result || "";
  const codeMatch = replyText.match(/code is: (\d{6})/);
  const pairingCode = codeMatch ? codeMatch[1] : null;

  let sessionToken = "";
  if (pairingCode) {
    const pairExchangeRes = await fetch(`${BASE_URL}/api/v1/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
    });
    const pairExchangeJson = (await pairExchangeRes.json()) as any;
    sessionToken = pairExchangeJson.data?.token || "";
  }
  record(!!sessionToken, "Established authenticated session for Block 6.2 tests");

  // ----------------------------------------------------
  // 2. TEST-6.2.1: Audit Ledger O(1) Head Retrieval
  // ----------------------------------------------------
  console.log("\n--- 2. TEST-6.2.1: Audit Head Retrieval ---");
  const initialLatestRes = await api("/api/v1/audit/latest", { method: "GET" }, sessionToken);
  const initialLatestJson = (await initialLatestRes.json()) as any;
  record(initialLatestRes.status === 200 && initialLatestJson.ok === true, "GET /api/v1/audit/latest returns 200 OK");
  const initialSeq = initialLatestJson.data?.head_sequence ?? 0;
  record(typeof initialSeq === "number", `Initial head sequence is integer: ${initialSeq}`);
  record(typeof initialLatestJson.data?.head_hash === "string", "Head hash is populated");

  // ----------------------------------------------------
  // 3. TEST-6.2.2: Event Ingress on Business Operations
  // ----------------------------------------------------
  console.log("\n--- 3. TEST-6.2.2: Event Ingress on Task Operations ---");
  const taskRes = await api(
    "/api/v1/tasks",
    {
      method: "POST",
      body: JSON.stringify({
        title: "Block 6.2 Forensic Audit Target Task",
        priority: "high",
        category: "academic",
      }),
    },
    sessionToken
  );
  const taskJson = (await taskRes.json()) as any;
  const taskId = taskJson.data?.id;
  record(taskRes.status === 201 && !!taskId, `Task created successfully: '${taskId}'`);

  // Complete the task
  const completeRes = await api(`/api/v1/tasks/${taskId}/complete`, { method: "POST" }, sessionToken);
  record(completeRes.status === 200, `Task completed: '${taskId}'`);

  // Small sleep to ensure fire-and-forget event commit
  await new Promise((r) => setTimeout(r, 200));

  // Verify head sequence advanced
  const postLatestRes = await api("/api/v1/audit/latest", { method: "GET" }, sessionToken);
  const postLatestJson = (await postLatestRes.json()) as any;
  const postSeq = postLatestJson.data?.head_sequence ?? 0;
  record(postSeq >= initialSeq + 2, `Audit head sequence advanced from ${initialSeq} to ${postSeq} after task mutations`);

  // ----------------------------------------------------
  // 4. TEST-6.2.3: Forensic Entity Replay
  // ----------------------------------------------------
  console.log("\n--- 4. TEST-6.2.3: Forensic Entity Replay ---");
  const replayRes = await api(`/api/v1/audit/entity/task/${taskId}`, { method: "GET" }, sessionToken);
  const replayJson = (await replayRes.json()) as any;
  record(replayRes.status === 200 && replayJson.ok === true, `GET /api/v1/audit/entity/task/${taskId} returns 200 OK`);
  const timeline = replayJson.data?.timeline || [];
  record(timeline.length >= 2, `Replay timeline contains ${timeline.length} chronological events`);
  record(timeline[0]?.eventType === "TASK_CREATED", "Timeline event 1 is 'TASK_CREATED'");
  record(timeline[1]?.eventType === "TASK_COMPLETED", "Timeline event 2 is 'TASK_COMPLETED'");
  record(timeline[0]?.summary.includes("created"), "Timeline event 1 contains human-readable summary");
  record(!("deadline" in timeline[0]), "Replay strictly emits forensic events without business object reconstitution");

  // ----------------------------------------------------
  // 5. TEST-6.2.4: Cryptographic Chain Verification
  // ----------------------------------------------------
  console.log("\n--- 5. TEST-6.2.4: Cryptographic Chain Verification ---");
  const verifyRes = await api("/api/v1/audit/verify", { method: "GET" }, sessionToken);
  const verifyJson = (await verifyRes.json()) as any;
  record(verifyRes.status === 200 && verifyJson.ok === true, "GET /api/v1/audit/verify returns 200 OK");
  record(verifyJson.data?.level === "VALID", "Cryptographic chain verification level is 'VALID'");
  record(verifyJson.data?.discrepancies?.length === 0, "Zero hash or sequence discrepancies detected");
  record(verifyJson.data?.checkedCount > 0, `Verified ${verifyJson.data?.checkedCount} ledger entries cleanly`);

  // ----------------------------------------------------
  // 6. TEST-6.2.5: Signed JSON Export with Manifest
  // ----------------------------------------------------
  console.log("\n--- 6. TEST-6.2.5: Signed JSON Export with Manifest ---");
  const signedExportRes = await api("/api/v1/audit/export?format=signed_json", { method: "GET" }, sessionToken);
  const signedExportJson = (await signedExportRes.json()) as any;
  record(signedExportRes.status === 200 && signedExportJson.ok === true, "GET /api/v1/audit/export returns 200 OK");
  const bundle = signedExportJson.data;
  record(!!bundle?.manifest, "Signed export includes manifest object");
  record(bundle?.manifest?.checksum_algorithm === "SHA-256", "Manifest declares SHA-256 checksum algorithm");
  record(Array.isArray(bundle?.records) && bundle.records.length > 0, `Export includes ${bundle?.records?.length} audit records`);

  // Verify offline manifest checksum matches canonical records
  const canonRecs = canonicalizeJson(bundle.records);
  const recomputedChecksum = await sha256Hex(canonRecs);
  record(recomputedChecksum === bundle.manifest.checksum, "Offline verifiable: Manifest checksum matches canonical records SHA-256 hash");

  // ----------------------------------------------------
  // 7. TEST-6.2.6: System Export Portability
  // ----------------------------------------------------
  console.log("\n--- 7. TEST-6.2.6: System Portability Export ---");
  const sysExportRes = await api("/api/v1/export?format=json", { method: "GET" }, sessionToken);
  const sysExportJson = (await sysExportRes.json()) as any;
  const auditChainExport = sysExportJson.data?.audit_chain || sysExportJson.data?.data?.audit_chain;
  record(Array.isArray(auditChainExport) && auditChainExport.length > 0, "Full portable export includes 'audit_chain' table records");

  // ----------------------------------------------------
  // 8. TEST-6.2.7: Rule 5 Zero Audit/Blockchain in Scheduler
  // ----------------------------------------------------
  console.log("\n--- 8. TEST-6.2.7: Rule 5 Invariant ---");
  const schedulerCode = fs.readFileSync("worker/scheduler.ts", "utf8");
  const hasAuditChain = schedulerCode.includes("audit_chain");
  const hasAuditService = schedulerCode.includes("AuditService");
  const hasBlockchain = /blockchain|merkle/i.test(schedulerCode);
  record(!hasAuditChain && !hasAuditService && !hasBlockchain, "Rule 5 Invariant: worker/scheduler.ts has 0 references to audit_chain, AuditService, or blockchain");

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log("\n========================================================");
  console.log(`TOTAL ACCEPTANCE TESTS: ${stats.passed + stats.failed} | PASSED: ${stats.passed} | FAILED: ${stats.failed}`);
  console.log("========================================================\n");

  if (stats.failed > 0) {
    process.exit(1);
  }
}

runAcceptanceBattery().catch((err) => {
  console.error("Acceptance runner fatal error:", err);
  process.exit(1);
});
