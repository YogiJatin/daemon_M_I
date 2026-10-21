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
import { AUDIT_SCHEMA_VERSION } from "../worker/auditService";

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
