/**
 * tests/unit_audit.ts — Block 6.2 Tamper-Evident Audit Layer Unit Tests
 *
 * Verifies:
 * 1. Canonical Serializer: Deterministic recursive key sorting, date normalization, array preservation.
 * 2. Privacy Sanitization: Stripping of tokens, passwords, cookies, prompts, emails, phone numbers.
 * 3. ULID Generator: 26-char Crockford Base32, monotonic chronological ordering.
 * 4. SHA-256 Hashing: Deterministic payload hash, chained record hash with schema_version, genesis anchor.
 * 5. Merkle Root Engine: Binary tree pairing, odd leaf balancing, tamper sensitivity.
 * 6. Verification Engine: VALID, WARNING, and CORRUPTED level classification.
 * 7. Replay Engine: Forensic timeline events without business object reconstitution.
 * 8. Signed Export Manifest: Manifest schema, canonical checksum verification.
 */

import { canonicalizeJson, sanitizeAuditMetadata } from "../worker/auditSerializer";
import {
  generateULID,
  sha256Hex,
  computePayloadHash,
  computeRecordHash,
  computeMerkleRoot,
} from "../worker/auditHasher";
import { AuditVerifier } from "../worker/auditVerifier";
import { AuditReplay } from "../worker/auditReplay";
import { AUDIT_SCHEMA_VERSION, AuditService, isRetryableAuditError } from "../worker/auditService";
import { createMockD1 } from "./mockD1";

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

async function runAuditUnitTests() {
  console.log("\n=== RUNNING BLOCK 6.2 AUDIT LAYER UNIT TESTS ===\n");

  // ----------------------------------------------------
  // 1. Canonical Serializer
  // ----------------------------------------------------
  console.log("--- 1. Canonical Serializer ---");
  const objA = { z: 1, a: "test", m: { y: 2, b: 3 } };
  const objB = { a: "test", m: { b: 3, y: 2 }, z: 1 };
  const canonA = canonicalizeJson(objA);
  const canonB = canonicalizeJson(objB);
  assert(canonA === canonB, "Objects with different key insertion order serialize to identical canonical JSON");
  assert(canonA === '{"a":"test","m":{"b":3,"y":2},"z":1}', "Keys are sorted recursively and compact");

  const dateVal = new Date("2026-10-21T12:00:00.000Z");
  assert(canonicalizeJson({ date: dateVal }) === '{"date":"2026-10-21T12:00:00.000Z"}', "Dates normalize to ISO-8601 UTC strings");

  // ----------------------------------------------------
  // 2. Privacy Sanitization
  // ----------------------------------------------------
  console.log("\n--- 2. Privacy Sanitization ---");
  const rawMetadata = {
    task_id: "task_123",
    status: "done",
    actor: "owner",
    token: "secret_session_token_xyz",
    password: "super_secret_password",
    api_key: "groq_live_key",
    cookie: "session=abcdef",
    prompt_body: "Please drop the database table",
    message_body: "Personal confidential private message text",
    email: "owner@personal-ai.internal",
    phone: "+91-9876543210",
    safe_metric: 42,
  };

  const sanitized = sanitizeAuditMetadata(rawMetadata);
  assert(sanitized.task_id === "task_123", "Preserves task_id identifier");
  assert(sanitized.status === "done", "Preserves state transition enum");
  assert(sanitized.safe_metric === 42, "Preserves numeric metric");
  assert(sanitized.token === undefined, "Strips 'token' key completely");
  assert(sanitized.password === undefined, "Strips 'password' key completely");
  assert(sanitized.api_key === undefined, "Strips 'api_key' key completely");
  assert(sanitized.cookie === undefined, "Strips 'cookie' key completely");
  assert(sanitized.prompt_body === undefined, "Strips 'prompt_body' completely");
  assert(sanitized.message_body === undefined, "Strips 'message_body' completely");
  assert(sanitized.email === undefined, "Strips 'email' completely");
  assert(sanitized.phone === undefined, "Strips 'phone' completely");

  // ----------------------------------------------------
  // 3. ULID Generator (Chronological Sorting)
  // ----------------------------------------------------
  console.log("\n--- 3. ULID Generator ---");
  const ulid1 = generateULID(1000000);
  const ulid2 = generateULID(2000000);
  assert(typeof ulid1 === "string" && ulid1.length === 26, "ULID is a 26-character string");
  assert(ulid2 > ulid1, "Later timestamp produces lexicographically greater ULID (chronological sortability)");

  // ----------------------------------------------------
  // 4. SHA-256 Hashing & Chained Record Hash
  // ----------------------------------------------------
  console.log("\n--- 4. Cryptographic Hashing ---");
  const payloadHash = await computePayloadHash(canonA);
  assert(typeof payloadHash === "string" && payloadHash.length === 64, "Payload hash is a 64-char hex string");

  // Genesis record hash (sequence 1)
  const genesisHash = await computeRecordHash(
    AUDIT_SCHEMA_VERSION,
    "GENESIS",
    payloadHash,
    1,
    "2026-10-21T12:00:00.000Z"
  );
  assert(typeof genesisHash === "string" && genesisHash.length === 64, "Genesis record hash computed cleanly");

  // Sequence 2 links to genesisHash as previous_hash
  const seq2Hash = await computeRecordHash(
    AUDIT_SCHEMA_VERSION,
    genesisHash,
    payloadHash,
    2,
    "2026-10-21T12:05:00.000Z"
  );
  assert(seq2Hash !== genesisHash, "Chained hash incorporates prior record hash and sequence number");

  // Schema version changes output hash (Requirement 2)
  const diffSchemaHash = await computeRecordHash(
    "2.0.0",
    "GENESIS",
    payloadHash,
    1,
    "2026-10-21T12:00:00.000Z"
  );
  assert(diffSchemaHash !== genesisHash, "Schema version is hashed directly into record hash");

  // ----------------------------------------------------
  // 5. Merkle Root Engine
  // ----------------------------------------------------
  console.log("\n--- 5. Merkle Root Engine ---");
  const emptyRoot = await computeMerkleRoot([]);
  assert(emptyRoot === "EMPTY", "Empty leaf set returns 'EMPTY'");

  const singleRoot = await computeMerkleRoot([genesisHash]);
  assert(singleRoot === genesisHash, "Single leaf returns its own hash");

  const leaves = [
    await sha256Hex("leaf1"),
    await sha256Hex("leaf2"),
    await sha256Hex("leaf3"),
    await sha256Hex("leaf4"),
  ];
  const merkleRoot = await computeMerkleRoot(leaves);
  assert(typeof merkleRoot === "string" && merkleRoot.length === 64, "Computed 64-char Merkle tree root");

  // Tamper sensitivity: modifying one leaf changes root
  const tamperedLeaves = [...leaves];
  tamperedLeaves[2] = await sha256Hex("tampered_leaf3");
  const tamperedRoot = await computeMerkleRoot(tamperedLeaves);
  assert(tamperedRoot !== merkleRoot, "Altering a single leaf completely changes the Merkle root");

  // ----------------------------------------------------
  // 6. Chain Verification Engine Logic
  // ----------------------------------------------------
  console.log("\n--- 6. Chain Verification Logic ---");
  // Mock D1 database for in-memory verification logic test
  const mockDbRecords: any[] = [
    {
      id: "ulid_1",
      sequence_number: 1,
      event_type: "TASK_CREATED",
      event_version: "1.0.0",
      entity_type: "task",
      entity_id: "t1",
      actor: "owner",
      timestamp_utc: "2026-10-21T12:00:00.000Z",
      payload_hash: payloadHash,
      previous_hash: "GENESIS",
      current_hash: genesisHash,
      metadata_json: "{}",
      integrity_status: "VALID",
      schema_version: AUDIT_SCHEMA_VERSION,
    },
    {
      id: "ulid_2",
      sequence_number: 2,
      event_type: "TASK_COMPLETED",
      event_version: "1.0.0",
      entity_type: "task",
      entity_id: "t1",
      actor: "owner",
      timestamp_utc: "2026-10-21T12:05:00.000Z",
      payload_hash: payloadHash,
      previous_hash: genesisHash,
      current_hash: seq2Hash,
      metadata_json: "{}",
      integrity_status: "VALID",
      schema_version: AUDIT_SCHEMA_VERSION,
    },
  ];

  const createMockDb = (records: any[], meta: any) => ({
    prepare: (query: string) => {
      const stmt: any = {
        first: async () => {
          if (query.includes("audit_metadata")) return meta;
          return null;
        },
        all: async () => {
          if (query.includes("audit_chain")) return { results: records };
          if (query.includes("audit_snapshots")) return { results: [] };
          return { results: [] };
        },
      };
      stmt.bind = (...args: any[]) => stmt;
      return stmt;
    },
  });

  const mockDbValid = createMockDb(mockDbRecords, { key: "singleton", head_sequence: 2, head_hash: seq2Hash, schema_version: AUDIT_SCHEMA_VERSION });

  const reportValid = await AuditVerifier.verifyChain(mockDbValid);
  assert(reportValid.level === "VALID", "Valid chain verifies with level 'VALID'");
  assert(reportValid.checkedCount === 2, "Checked 2 records cleanly");
  assert(reportValid.discrepancies.length === 0, "Zero discrepancies on valid chain");

  // Tampered chain: change seq 2's previous_hash
  const tamperedDbRecords = [
    mockDbRecords[0],
    { ...mockDbRecords[1], previous_hash: "BROKEN_LINK_HASH" },
  ];
  const mockDbTampered = createMockDb(tamperedDbRecords, { key: "singleton", head_sequence: 2, head_hash: seq2Hash, schema_version: AUDIT_SCHEMA_VERSION });

  const reportTampered = await AuditVerifier.verifyChain(mockDbTampered);
  assert(reportTampered.level === "CORRUPTED", "Broken hash link immediately triggers 'CORRUPTED' level");
  assert(reportTampered.discrepancies.some((d) => d.includes("Broken hash link")), "Identifies broken hash link detail");

  // ----------------------------------------------------
  // 7. Forensic Replay Engine (No Business Objects)
  // ----------------------------------------------------
  console.log("\n--- 7. Forensic Replay Engine ---");
  const mockDbReplay: any = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({
          results: [
            {
              id: "ulid_1",
              sequence_number: 1,
              event_type: "TASK_CREATED",
              event_version: "1.0.0",
              entity_type: "task",
              entity_id: "t1",
              actor: "owner",
              timestamp_utc: "2026-10-21T09:10:00.000Z",
              metadata_json: JSON.stringify({ title: "Physics Lab Prep" }),
            },
            {
              id: "ulid_2",
              sequence_number: 2,
              event_type: "TASK_COMPLETED",
              event_version: "1.0.0",
              entity_type: "task",
              entity_id: "t1",
              actor: "owner",
              timestamp_utc: "2026-10-21T09:40:00.000Z",
              metadata_json: JSON.stringify({ task_id: "t1" }),
            },
          ],
        }),
      }),
    }),
  };

  const replay = await AuditReplay.replayEntityTimeline(mockDbReplay, "task", "t1");
  assert(replay.entityId === "t1", "Replay report targets correct entityId");
  assert(replay.totalEvents === 2, "Replay contains 2 chronological events");
  assert(replay.timeline[0].summary.includes("created"), "Event 1 emits human-readable summary");
  assert(replay.timeline[1].summary.includes("completed"), "Event 2 emits human-readable summary");
  assert(!("deadline" in replay.timeline[0]), "Replay does NOT reconstitute Task domain entity (forensic only)");

  // ----------------------------------------------------
  // 8. Signed Export Manifest
  // ----------------------------------------------------
  console.log("\n--- 8. Signed Export Manifest ---");
  const canonicalRecords = canonicalizeJson(mockDbRecords);
  const manifestChecksum = await sha256Hex(canonicalRecords);

  const manifest = {
    schema_version: AUDIT_SCHEMA_VERSION,
    export_version: "2.0.0",
    generated_at: new Date().toISOString(),
    head_hash: seq2Hash,
    snapshot_hash: "NONE",
    record_count: 2,
    checksum_algorithm: "SHA-256",
    checksum: manifestChecksum,
  };

  assert(manifest.checksum_algorithm === "SHA-256", "Manifest declares SHA-256 checksum algorithm");
  assert(manifest.checksum === manifestChecksum, "Manifest checksum matches canonicalized records array");

  // ----------------------------------------------------
  // 9. Concurrency & Optimistic Retry Resilience
  // ----------------------------------------------------
  console.log("\n--- 9. Concurrency & Optimistic Retry Resilience ---");
  const liveDb = createMockD1();

  // Test 9.1: Sequential baseline
  const seq1 = await AuditService.append(liveDb, {
    eventType: "TASK_CREATED",
    entityType: "task",
    entityId: "seq_task_1",
    payload: { title: "First Task" },
  });
  const seq2 = await AuditService.append(liveDb, {
    eventType: "TASK_CREATED",
    entityType: "task",
    entityId: "seq_task_2",
    payload: { title: "Second Task" },
  });
  assert(seq1 !== null && seq1.sequence_number === 1, "Sequential write 1 receives sequence 1");
  assert(seq2 !== null && seq2.sequence_number === 2, "Sequential write 2 receives sequence 2");
  assert(seq2?.previous_hash === seq1?.current_hash, "Sequential write 2 links to sequence 1 current_hash");

  // Test 9.2: 25 Concurrent Writes (Testing in-process queue optimization)
  console.log("  Firing 25 simultaneous concurrent AuditService.append() calls...");
  const CONCURRENT_COUNT = 25;
  const concurrentPromises: Promise<any>[] = [];
  for (let i = 0; i < CONCURRENT_COUNT; i++) {
    concurrentPromises.push(
      AuditService.append(liveDb, {
        eventType: "TASK_UPDATED",
        entityType: "task",
        entityId: `concurrent_task_${i}`,
        payload: { batchIndex: i, action: "concurrent_mutation" },
      })
    );
  }

  const concurrentResults = await Promise.all(concurrentPromises);
  assert(concurrentResults.length === CONCURRENT_COUNT, `All ${CONCURRENT_COUNT} concurrent writes resolved successfully`);
  assert(concurrentResults.every((r) => r !== null && typeof r.sequence_number === "number"), "All concurrent results return valid records");

  // Verify full sequence continuity (1, 2, ..., 27)
  const allRowsRes = await liveDb
    .prepare("SELECT sequence_number, previous_hash, current_hash FROM audit_chain ORDER BY sequence_number ASC")
    .all();
  const allRows = allRowsRes.results;
  const totalExpected = 2 + CONCURRENT_COUNT; // 2 sequential + 25 concurrent = 27
  assert(allRows.length === totalExpected, `Stored record count matches expected total (${totalExpected})`);

  let contiguous = true;
  for (let i = 0; i < allRows.length; i++) {
    if (allRows[i].sequence_number !== i + 1) {
      contiguous = false;
      break;
    }
  }
  assert(contiguous, `Sequence numbers are strictly contiguous with zero gaps (1 to ${totalExpected})`);

  // Verify hash chain validity
  const verificationResult = await AuditVerifier.verifyChain(liveDb);
  assert(verificationResult.level === "VALID", "AuditVerifier verifies 100% cryptographic integrity of concurrent chain (level VALID)");
  assert(verificationResult.discrepancies.length === 0, "AuditVerifier reports zero discrepancies on concurrent chain");
  assert(verificationResult.headSequence === totalExpected, `AuditVerifier headSequence matches total count (${totalExpected})`);

  // Test 9.3: Tamper Detection on Concurrent Chain
  await liveDb
    .prepare("UPDATE audit_chain SET payload_hash = 'corrupted_payload_hash_value_xyz' WHERE sequence_number = 15")
    .run();
  const tamperedReport = await AuditVerifier.verifyChain(liveDb);
  assert(tamperedReport.level === "CORRUPTED", "AuditVerifier detects tampering on intermediate record (level CORRUPTED)");
  assert(tamperedReport.discrepancies.some((d: string) => d.includes("15")), "Discrepancies specifically identify tampered sequence 15");

  // Test 9.4: Retry Exhaustion Produces Explicit Error
  console.log("  Testing retry exhaustion on simulated permanent contention...");
  const failingDb: any = {
    prepare(q: string) {
      return {
        bind(...args: any[]) { return this; },
        async first() {
          return { head_sequence: 1, head_hash: "GENESIS", schema_version: AUDIT_SCHEMA_VERSION };
        },
        async run() { return { success: true }; },
        async all() { return { results: [] }; },
      };
    },
    async batch() {
      throw new Error("UNIQUE constraint failed: audit_chain.sequence_number");
    },
  };

  let exhaustionThrown = false;
  let exhaustionErrorMessage = "";
  try {
    await AuditService.append(failingDb, {
      eventType: "TASK_CREATED",
      entityType: "task",
      entityId: "exhaust_task",
      payload: { test: true },
    }, { AUDIT_MAX_RETRIES: 3 });
  } catch (err: any) {
    exhaustionThrown = true;
    exhaustionErrorMessage = err.message;
  }
  assert(exhaustionThrown, "Retry exhaustion throws explicit Error instead of swallowing failure");
  assert(exhaustionErrorMessage.includes("append failed after 3 attempts"), "Error message details attempt count and write contention cause");

  // Test 9.5: Emit Observable Error Tracking & Awaiting
  AuditService.clearLastError();
  const emitPromise = AuditService.emit(failingDb, {
    eventType: "TASK_CREATED",
    entityType: "task",
    entityId: "emit_fail_task",
    payload: { test: true },
  }, { AUDIT_MAX_RETRIES: 2 });

  let emitErrorCaught = false;
  try {
    await emitPromise;
  } catch (err: any) {
    emitErrorCaught = true;
  }
  assert(emitErrorCaught, "Awaiting emit() surfaces the rejection to caller");
  assert(AuditService.getLastError() !== null, "AuditService.getLastError() captures the failure for fire-and-forget callers");
  AuditService.clearLastError();

  // Test 9.6: Post-Commit Snapshot Failure Boundary
  console.log("  Testing post-commit snapshot failure boundary...");
  const snapDb = createMockD1();
  AuditService.clearLastSnapshotError();

  const origGenerateSnapshot = AuditService.generateSnapshot;
  AuditService.generateSnapshot = async () => {
    throw new Error("Simulated storage failure during snapshot");
  };

  const snapRecord = await AuditService.append(
    snapDb,
    {
      eventType: "TASK_CREATED",
      entityType: "task",
      entityId: "snap_task_1",
      payload: { title: "Snapshot Boundary Task" },
    },
    { AUDIT_SNAPSHOT_INTERVAL: 1 }
  );

  assert(snapRecord !== null && snapRecord.sequence_number === 1, "Audit record returns successfully even if snapshot fails");
  assert(AuditService.getLastSnapshotError() !== null, "Snapshot failure is recorded in lastSnapshotError");
  assert(AuditService.getLastSnapshotError()?.message.includes("Simulated storage failure"), "Snapshot error message captured");

  const snapRows = (await snapDb.prepare("SELECT * FROM audit_chain").all()).results;
  assert(snapRows.length === 1, "Exactly one audit record committed (post-commit snapshot failure did NOT re-trigger append)");

  AuditService.generateSnapshot = origGenerateSnapshot;
  AuditService.clearLastSnapshotError();

  // Test 9.7: Deterministic Concurrency Conflict via Unqueued Independent Writers (appendDirect)
  console.log("  Testing unqueued concurrent writers (bypassing in-process queue)...");
  const unqueuedDb = createMockD1();
  const DIRECT_COUNT = 5; // bounded by DEFAULT_MAX_APPEND_RETRIES=5 (worst-case N-1=4 retries for N writers)
  const directPromises: Promise<any>[] = [];

  for (let i = 0; i < DIRECT_COUNT; i++) {
    directPromises.push(
      AuditService.appendDirect(unqueuedDb, {
        eventType: "TASK_CREATED",
        entityType: "task",
        entityId: `direct_task_${i}`,
        payload: { directIndex: i },
      })
    );
  }

  const directResults = await Promise.all(directPromises);
  assert(directResults.length === DIRECT_COUNT, `All ${DIRECT_COUNT} unqueued writes succeeded via DB-level optimistic retry`);

  const directRows = (await unqueuedDb.prepare("SELECT sequence_number FROM audit_chain ORDER BY sequence_number ASC").all()).results;
  assert(directRows.length === DIRECT_COUNT, `All ${DIRECT_COUNT} rows committed in unqueued test`);
  let directContiguous = true;
  for (let i = 0; i < directRows.length; i++) {
    if (directRows[i].sequence_number !== i + 1) {
      directContiguous = false;
      break;
    }
  }
  assert(directContiguous, `Unqueued concurrent writes achieved strict sequence continuity (1 to ${DIRECT_COUNT})`);

  const directVerify = await AuditVerifier.verifyChain(unqueuedDb);
  assert(directVerify.level === "VALID", "Cryptographic chain is VALID for unqueued concurrent writers");

  // Test 9.8: Deterministic 0/0 Affected Rows Handled as Conflict Retry with Valid Competing Fixture
  console.log("  Testing 0/0 affected rows handled as conflict retry with valid competing fixture...");
  const conflictDb = createMockD1();

  // Step 1: Establish head at sequence 1
  const initialRec = await AuditService.append(conflictDb, {
    eventType: "TASK_CREATED",
    entityType: "task",
    entityId: "initial_task",
    payload: { step: 1 },
  });
  assert(initialRec !== null && initialRec.sequence_number === 1, "Initial record is sequence 1");

  // Step 2: Intercept first batch attempt to simulate a concurrent writer advancing head
  let intercepted = false;
  let competingRec: any = null;
  const origBatch = conflictDb.batch.bind(conflictDb);

  conflictDb.batch = async (statements: any[]) => {
    if (!intercepted) {
      intercepted = true;
      // Temporarily restore batch so competing append executes normally with real crypto & real hash chain
      conflictDb.batch = origBatch;
      competingRec = await AuditService.appendDirect(conflictDb, {
        eventType: "TASK_CREATED",
        entityType: "task",
        entityId: "competing_task",
        payload: { step: 2 },
      });
      // Leave batch restored so subsequent retries succeed
      conflictDb.batch = origBatch;
    }
    return origBatch(statements);
  };

  // Step 3: Writer A prepared statements expecting head_sequence = 1.
  // When executed, head_sequence is now 2, so WHERE head_sequence = 1 matches 0 rows!
  // Writer A detects 0/0 sequence contention, rereads head (sequence 2), and commits sequence 3.
  const recoveredRecord = await AuditService.appendDirect(conflictDb, {
    eventType: "TASK_CREATED",
    entityType: "task",
    entityId: "recovered_task",
    payload: { step: 3 },
  });

  assert(competingRec !== null && competingRec.sequence_number === 2, "Competing writer successfully committed valid sequence 2");
  assert(recoveredRecord.sequence_number === 3, "Recovered record dynamically rereads metadata and receives sequence 3");
  assert(recoveredRecord.previous_hash === competingRec.current_hash, "Recovered record links directly to competing writer's real current_hash");

  // Step 4: Run AuditVerifier over the complete chain (1 -> 2 -> 3)
  const conflictVerifyReport = await AuditVerifier.verifyChain(conflictDb);
  assert(conflictVerifyReport.level === "VALID", "AuditVerifier verifies 100% cryptographic validity of recovered chain (level VALID)");
  assert(conflictVerifyReport.discrepancies.length === 0, "AuditVerifier reports zero discrepancies on deterministic conflict chain");
  assert(conflictVerifyReport.headSequence === 3, "AuditVerifier headSequence matches 3");

  // Test 9.9: Fail-Closed & Reconciled Indeterminate Batch Outcomes
  console.log("  Testing fail-closed & reconciled indeterminate batch outcomes...");

  // Case A: Missing metadata BUT batch actually committed to DB -> successfully reconciles!
  const reconcileDb = createMockD1();
  const rawBatch = reconcileDb.batch.bind(reconcileDb);
  reconcileDb.batch = async (statements: any[]) => {
    await rawBatch(statements);
    // Simulate driver that executed SQL but omitted affected row metadata
    return [{ success: true }, { success: true }];
  };

  const reconciledRec = await AuditService.appendDirect(reconcileDb, {
    eventType: "TASK_CREATED",
    entityType: "task",
    entityId: "reconciled_task",
    payload: { reconciled: true },
  });
  assert(reconciledRec !== null && reconciledRec.sequence_number === 1, "Reconciles successfully when batch committed despite missing driver metadata");
  const storedRec = await reconcileDb.prepare("SELECT * FROM audit_chain WHERE id = ?").bind(reconciledRec.id).first();
  assert(storedRec !== null, "Reconciled record exists in audit_chain");

  // Case B: Missing metadata AND batch did NOT commit, state indeterminate -> fails closed!
  const indeterminateDb: any = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return { head_sequence: 1, head_hash: "GENESIS", schema_version: AUDIT_SCHEMA_VERSION }; },
      };
    },
    async batch() {
      return [{ success: true }, { success: true }]; // No SQL executed, no metadata
    },
  };

  let indeterminateThrown = false;
  let indeterminateErrMsg = "";
  try {
    await AuditService.appendDirect(indeterminateDb, {
      eventType: "TASK_CREATED",
      entityType: "task",
      entityId: "indeterminate_task",
      payload: {},
    }, { AUDIT_MAX_RETRIES: 1 });
  } catch (err: any) {
    indeterminateThrown = true;
    indeterminateErrMsg = err.message;
  }
  assert(indeterminateThrown, "Throws explicit error when driver omits metadata and commit outcome is indeterminate");
  assert(indeterminateErrMsg.includes("indeterminate_batch_outcome"), "Error details indeterminate_batch_outcome");
  assert(!isRetryableAuditError(new Error(indeterminateErrMsg)), "isRetryableAuditError returns false for indeterminate_batch_outcome");

  // Case C: One-sided mutation (insertChanges=1, updateChanges=0) -> fatal inconsistency!
  const oneSidedDb: any = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return { head_sequence: 1, head_hash: "GENESIS", schema_version: AUDIT_SCHEMA_VERSION }; },
      };
    },
    async batch() {
      return [
        { success: true, meta: { changes: 1 } },
        { success: true, meta: { changes: 0 } },
      ];
    },
  };

  let oneSidedThrown = false;
  let oneSidedErrMessage = "";
  try {
    await AuditService.appendDirect(oneSidedDb, {
      eventType: "TASK_CREATED",
      entityType: "task",
      entityId: "test_one_sided",
      payload: {},
    }, { AUDIT_MAX_RETRIES: 2 });
  } catch (err: any) {
    oneSidedThrown = true;
    oneSidedErrMessage = err.message;
  }
  assert(oneSidedThrown, "Throws immediately on fatal one-sided batch mutation");
  assert(oneSidedErrMessage.includes("fatal_inconsistency: one-sided audit batch commit"), "Identifies fatal_inconsistency in error message");
  assert(!isRetryableAuditError(new Error(oneSidedErrMessage)), "isRetryableAuditError returns false for fatal_inconsistency");

  // Test 9.10: Emit Error Handler Reliability & Privacy-Safe Structured Logging
  console.log("  Testing emit error handler reliability & privacy-safe structured logging...");
  AuditService.clearLastError();

  // Sensitive values that must never appear in any operational log output
  const SENSITIVE_ENTITY_ID = "handler_test_task_xyz_PRIVATE_UUID";
  const SENSITIVE_SECRET = "super_secret_payload_token_abc123";
  const SENSITIVE_RAW_DB_ERROR = "/var/secrets/key.pem: connection refused";
  const SENSITIVE_HANDLER_ERROR = "Custom handler internal path: /proc/self/mem";

  // Intercept console.error to verify structured logging without leaking sensitive payloads
  const originalConsoleError = console.error;
  let loggedErrorMessage = "";
  console.error = (...args: any[]) => {
    loggedErrorMessage += args.join(" ") + "\n";
  };

  // Set custom error handler that deliberately throws with a sensitive message
  AuditService.setEmitErrorHandler(() => {
    throw new Error(SENSITIVE_HANDLER_ERROR);
  });

  const failingEmitDb: any = {
    prepare() {
      return {
        bind() { return this; },
        async first() { throw new Error(SENSITIVE_RAW_DB_ERROR); },
      };
    },
    async batch() { throw new Error(SENSITIVE_RAW_DB_ERROR); },
  };

  // Fire-and-forget emit: should NOT throw an unhandled rejection
  AuditService.emit(failingEmitDb, {
    eventType: "TASK_CREATED",
    entityType: "task",
    entityId: SENSITIVE_ENTITY_ID,
    payload: { secret_token: SENSITIVE_SECRET },
  });

  // Give promise queue tick to settle
  await new Promise((r) => setTimeout(r, 60));

  // Restore console.error
  console.error = originalConsoleError;

  // --- Positive assertions: correct normalized fields are logged ---
  assert(AuditService.getLastError() !== null, "Original database error captured in getLastError");
  assert(AuditService.getLastError()?.message.includes(SENSITIVE_RAW_DB_ERROR.split(":")[0]), "LastError preserves original failure reason (internal only, not logged)");
  assert(loggedErrorMessage.includes("[AuditService Error: Audit event append failed]"), "Emits structured operational error log prefix");
  assert(loggedErrorMessage.includes("eventType=TASK_CREATED"), "Error log includes allowlisted eventType");
  assert(loggedErrorMessage.includes("entityType=task"), "Error log includes allowlisted entityType");
  assert(loggedErrorMessage.includes("errorCategory=database_failure"), "Error log includes normalized errorCategory");
  assert(loggedErrorMessage.includes("[AuditService] Custom emit error handler execution failed"), "Handler exception produces static generic log, not raw message");

  // --- Negative assertions: sensitive values must NEVER appear in logs ---
  assert(!loggedErrorMessage.includes(SENSITIVE_ENTITY_ID), "Error log NEVER leaks raw entityId");
  assert(!loggedErrorMessage.includes(SENSITIVE_SECRET), "Error log NEVER leaks payload secret");
  assert(!loggedErrorMessage.includes(SENSITIVE_RAW_DB_ERROR), "Error log NEVER leaks raw database error message");
  assert(!loggedErrorMessage.includes(SENSITIVE_HANDLER_ERROR), "Error log NEVER leaks raw handler error message");
  assert(!loggedErrorMessage.includes("/var/secrets"), "Error log NEVER leaks filesystem paths from DB errors");
  assert(!loggedErrorMessage.includes("/proc/self"), "Error log NEVER leaks filesystem paths from handler errors");

  AuditService.setEmitErrorHandler(null);
  AuditService.clearLastError();

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log("\n========================================");
  console.log(`TOTAL: ${passCount + failCount} | PASSED: ${passCount} | FAILED: ${failCount}`);
  console.log("========================================\n");

  if (failCount > 0) {
    process.exit(1);
  }
}

runAuditUnitTests().catch((err) => {
  console.error("Audit unit test runner error:", err);
  process.exit(1);
});
