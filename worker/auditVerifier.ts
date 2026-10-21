/**
 * worker/auditVerifier.ts
 *
 * Cryptographic Chain Verification Engine for Audit Ledger.
 *
 * Verification Levels (Requirement 8):
 * - VALID: Perfect cryptographic integrity, all hash links verified, snapshots match.
 * - WARNING: Minor anomalies such as schema version differences, missing snapshot, or timestamp skew.
 * - CORRUPTED: Critical failures: broken hash links, tampered hashes, sequence gaps, invalid genesis.
 */

import { computeRecordHash, computeMerkleRoot } from "./auditHasher";
import { AuditRecord, AuditMetadata, AUDIT_SCHEMA_VERSION } from "./auditService";

export type VerificationLevel = "VALID" | "WARNING" | "CORRUPTED";

export interface VerificationReport {
  level: VerificationLevel;
  checkedCount: number;
  headSequence: number;
  discrepancies: string[];
  snapshotsVerified: number;
  verifiedAt: string;
}

export class AuditVerifier {
  /**
   * Verifies the cryptographic integrity of the audit chain across a sequence range.
   */
  public static async verifyChain(
    db: D1Database,
    fromSeq: number = 1,
    toSeq?: number
  ): Promise<VerificationReport> {
    const discrepancies: string[] = [];
    let hasWarnings = false;
    let hasCorruption = false;
    let snapshotsVerified = 0;

    const meta = await db
      .prepare("SELECT * FROM audit_metadata WHERE key = 'singleton'")
      .first<AuditMetadata>();

    const maxSeq = toSeq !== undefined ? toSeq : meta?.head_sequence || 0;

    if (maxSeq === 0) {
      return {
        level: "VALID",
        checkedCount: 0,
        headSequence: 0,
        discrepancies: [],
        snapshotsVerified: 0,
        verifiedAt: new Date().toISOString(),
      };
    }

    // Fetch records in range in strict sequential order
    const recordsRes = await db
      .prepare(
        `SELECT * FROM audit_chain
         WHERE sequence_number BETWEEN ? AND ?
         ORDER BY sequence_number ASC`
      )
      .bind(fromSeq, maxSeq)
      .all<AuditRecord>();

    const records = recordsRes.results || [];

    if (records.length === 0) {
      return {
        level: "WARNING",
        checkedCount: 0,
        headSequence: maxSeq,
        discrepancies: [`No records found in sequence range [${fromSeq}, ${maxSeq}]`],
        snapshotsVerified: 0,
        verifiedAt: new Date().toISOString(),
      };
    }

    let expectedSeq = fromSeq;
    let prevHash: string | null = null;

    if (fromSeq === 1) {
      prevHash = "GENESIS";
    } else {
      // Find previous hash before fromSeq
      const prevRecord = await db
        .prepare("SELECT current_hash FROM audit_chain WHERE sequence_number = ?")
        .bind(fromSeq - 1)
        .first<{ current_hash: string }>();
      prevHash = prevRecord?.current_hash || null;
    }

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];

      // 1. Check Sequence Monotonicity
      if (rec.sequence_number !== expectedSeq) {
        hasCorruption = true;
        discrepancies.push(
          `Sequence gap or out-of-order sequence: expected ${expectedSeq}, got ${rec.sequence_number}`
        );
      }
      expectedSeq = rec.sequence_number + 1;

      // 2. Check Genesis Block
      if (rec.sequence_number === 1 && rec.previous_hash !== "GENESIS") {
        hasCorruption = true;
        discrepancies.push(
          `Genesis block sequence 1 invalid previous_hash: expected 'GENESIS', got '${rec.previous_hash}'`
        );
      }

      // 3. Check Chained Link from Prior Record
      if (prevHash !== null && rec.previous_hash !== prevHash) {
        hasCorruption = true;
        discrepancies.push(
          `Broken hash link at sequence ${rec.sequence_number}: expected previous_hash '${prevHash}', got '${rec.previous_hash}'`
        );
      }

      // 4. Recompute and Verify Current Hash
      const expectedCurrentHash = await computeRecordHash(
        rec.schema_version,
        rec.previous_hash,
        rec.payload_hash,
        rec.sequence_number,
        rec.timestamp_utc
      );

      if (rec.current_hash !== expectedCurrentHash) {
        hasCorruption = true;
        discrepancies.push(
          `Tampered record hash at sequence ${rec.sequence_number}: stored '${rec.current_hash}', computed '${expectedCurrentHash}'`
        );
      }

      // 5. Schema Version Check
      if (rec.schema_version !== AUDIT_SCHEMA_VERSION) {
        hasWarnings = true;
        discrepancies.push(
          `Schema version discrepancy at sequence ${rec.sequence_number}: current '${AUDIT_SCHEMA_VERSION}', record '${rec.schema_version}'`
        );
      }

      prevHash = rec.current_hash;
    }

    // 6. Verify Snapshots Covering this Window
    const snapshotsRes = await db
      .prepare(
        `SELECT * FROM audit_snapshots
         WHERE first_sequence >= ? AND last_sequence <= ?
         ORDER BY first_sequence ASC`
      )
      .bind(fromSeq, maxSeq)
      .all<any>();

    for (const snap of snapshotsRes.results || []) {
      const windowRecords = records.filter(
        (r) => r.sequence_number >= snap.first_sequence && r.sequence_number <= snap.last_sequence
      );
      const leafHashes = windowRecords.map((r) => r.current_hash);
      const recomputedRoot = await computeMerkleRoot(leafHashes);

      if (snap.merkle_root !== recomputedRoot) {
        hasCorruption = true;
        discrepancies.push(
          `Merkle snapshot mismatch for window [${snap.first_sequence}, ${snap.last_sequence}]: stored '${snap.merkle_root}', computed '${recomputedRoot}'`
        );
      } else {
        snapshotsVerified++;
      }
    }

    const level: VerificationLevel = hasCorruption ? "CORRUPTED" : hasWarnings ? "WARNING" : "VALID";

    return {
      level,
      checkedCount: records.length,
      headSequence: maxSeq,
      discrepancies,
      snapshotsVerified,
      verifiedAt: new Date().toISOString(),
    };
  }
}
