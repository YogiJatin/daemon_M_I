/**
 * worker/auditHasher.ts
 *
 * Cryptographic Hash Engine & ULID Generator for Audit Ledger.
 *
 * Features:
 * - Chronologically sortable ULID generation (Crockford's Base32).
 * - Web Crypto API SHA-256 deterministic hashing.
 * - Chained current_hash computation including schema_version.
 * - Merkle root computation over sequence windows.
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a 26-character chronologically sortable ULID.
 * 10 chars (48-bit timestamp) + 16 chars (80-bit randomness).
 */
export function generateULID(timestamp: number = Date.now()): string {
  // 1. Time component (48 bits -> 10 Base32 characters)
  let timeStr = "";
  let time = timestamp;
  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeStr = CROCKFORD_BASE32[mod] + timeStr;
    time = Math.floor(time / 32);
  }

  // 2. Randomness component (80 bits -> 16 Base32 characters)
  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    // Pick from randomBytes
    const byteIndex = Math.floor((i * 5) / 8);
    const bitOffset = (i * 5) % 8;
    let val = (randomBytes[byteIndex] >> (8 - bitOffset - 5)) & 0x1f;
    if (bitOffset > 3 && byteIndex + 1 < randomBytes.length) {
      const extraBits = (randomBytes[byteIndex + 1] >> (16 - bitOffset - 5)) & 0x1f;
      val = (val | extraBits) & 0x1f;
    }
    randStr += CROCKFORD_BASE32[val % 32];
  }

  return timeStr + randStr;
}

/**
 * Computes standard hex-encoded SHA-256 using Web Crypto API.
 */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes SHA-256 hash of canonical payload JSON.
 */
export async function computePayloadHash(canonicalJson: string): Promise<string> {
  return sha256Hex(canonicalJson);
}

/**
 * Computes chained current_hash for a ledger entry.
 * Hash incorporates: schema_version + previous_hash + payload_hash + sequence_number + timestamp_utc
 */
export async function computeRecordHash(
  schemaVersion: string,
  previousHash: string,
  payloadHash: string,
  sequenceNumber: number,
  timestampUtc: string
): Promise<string> {
  const content = `${schemaVersion}:${previousHash}:${payloadHash}:${sequenceNumber}:${timestampUtc}`;
  return sha256Hex(content);
}

/**
 * Computes binary Merkle tree root from an array of leaf record hashes.
 */
export async function computeMerkleRoot(leafHashes: string[]): Promise<string> {
  if (leafHashes.length === 0) {
    return "EMPTY";
  }
  if (leafHashes.length === 1) {
    return leafHashes[0];
  }

  let currentLevel = [...leafHashes];

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      // If odd number of elements, pair the last element with itself
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
      const combined = await sha256Hex(`${left}:${right}`);
      nextLevel.push(combined);
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}
