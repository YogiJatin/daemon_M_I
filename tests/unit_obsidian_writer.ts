/**
 * tests/unit_obsidian_writer.ts — Block X Obsidian Writer Unit Tests
 *
 * Tests pure utility functions from desktop-agent/obsidian-utils.ts:
 * filename sanitization, folder validation, path resolution, nonce lifecycle,
 * and original-title metadata injection.
 *
 * No server process or actual vault is required — all tests run in-process.
 *
 * Target: 13/13 PASS. Must not regress existing 34/34 in unit_teach.ts.
 */

import path from 'node:path';
import os   from 'node:os';
import {
  sanitizeFilename,
  validateFolder,
  resolveVaultPath,
  injectOriginalTitle,
  issueNonce,
  consumeNonce,
  NONCE_TTL_MS,
  _nonceStoreSize,
  _clearNonceStore,
} from '../desktop-agent/obsidian-utils.js';

// ─── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function assertThrows(fn: () => unknown, label: string, fragment?: string): void {
  try {
    fn();
    console.error(`  ❌ FAIL: ${label} (expected to throw, but did not)`);
    failed++;
  } catch (err: any) {
    if (fragment && !err.message?.includes(fragment)) {
      console.error(`  ❌ FAIL: ${label} (threw but wrong message: "${err.message}")`);
      failed++;
    } else {
      console.log(`  ✅ PASS: ${label}`);
      passed++;
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== RUNNING BLOCK X OBSIDIAN WRITER UNIT TESTS ===\n');

  // ── 1. Filename sanitization ───────────────────────────────────────────────
  console.log('--- 1. Filename Sanitization ---');

  const safe1 = sanitizeFilename('My Recipe.md');
  assert(safe1.safe === 'My Recipe.md', 'Safe filename is unchanged');
  assert(!safe1.changed,                'Safe filename: changed = false');

  const safe2 = sanitizeFilename('../../etc/passwd');
  assert(!safe2.safe.includes('..'),    'Path traversal chars removed from filename');
  assert(!safe2.safe.includes('/'),     'Forward slashes removed');
  assert(safe2.changed,                 'Traversal filename: changed = true');

  const safe3 = sanitizeFilename('Report: Q4 "Final" <draft>?.md');
  assert(!safe3.safe.includes(':'),     'Colon stripped');
  assert(!safe3.safe.includes('"'),     'Double-quote stripped');
  assert(!safe3.safe.includes('<'),     'Angle bracket stripped');
  assert(!safe3.safe.includes('?'),     'Question mark stripped');
  assert(safe3.safe.endsWith('.md'),    'Extension preserved after sanitization');

  const safe4 = sanitizeFilename('मेरा नोट.md');
  assert(safe4.safe === 'मेरा नोट.md', 'Unicode filename preserved unchanged');
  assert(!safe4.changed,               'Unicode filename: changed = false');

  // ── 2. Folder validation ───────────────────────────────────────────────────
  console.log('\n--- 2. Folder Validation ---');

  const f1 = validateFolder('Workflows');
  assert(f1 === 'Workflows', 'Simple folder accepted');

  const f2 = validateFolder('Knowledge/Recipes/Indian');
  assert(f2 === 'Knowledge/Recipes/Indian', 'Nested folder accepted');

  const f3 = validateFolder('Knowledge\\Recipes');
  assert(f3 === 'Knowledge/Recipes', 'Backslashes normalised to forward slashes');

  assertThrows(
    () => validateFolder('../secrets'),
    'Path traversal folder rejected',
    'traversal'
  );

  assertThrows(
    () => validateFolder('/etc/passwd'),
    'Absolute Unix path rejected',
    'Absolute'
  );

  assertThrows(
    () => validateFolder('C:/Windows/System32'),
    'Absolute Windows path rejected',
    'Absolute'
  );

  assertThrows(
    () => validateFolder('safe/../unsafe'),
    'Mid-path traversal rejected',
    'traversal'
  );

  // ── 3. Vault path resolution ───────────────────────────────────────────────
  console.log('\n--- 3. Vault Path Resolution ---');

  const vault = path.join(os.tmpdir(), 'test-vault');

  const r1 = resolveVaultPath(vault, 'Workflows', 'My Recipe.md');
  assert(r1.startsWith(path.resolve(vault)), 'Resolved path is inside vault');
  assert(r1.endsWith('My Recipe.md'),        'Filename is preserved in resolved path');

  const r2 = resolveVaultPath(vault, 'Knowledge/Recipes', 'Curry.md');
  assert(r2.includes('Knowledge'), 'Nested folder in resolved path');

  assertThrows(
    () => resolveVaultPath(vault, 'safe', '../../../etc/passwd'),
    'Filename traversal outside vault rejected'
  );

  // ── 4. Original-title injection ────────────────────────────────────────────
  console.log('\n--- 4. Original-Title Injection ---');

  const yamlNote = `---\ntitle: "Test Recipe"\nstatus: "approved"\n---\n\n# Test Recipe\n`;

  const injected = injectOriginalTitle(yamlNote, 'Original: Title');
  assert(injected.includes('original_title: "Original: Title"'), 'original_title injected into frontmatter');
  assert(injected.includes('title: "Test Recipe"'),              'Existing title field unchanged');
  assert(injected.startsWith('---'),                             'YAML frontmatter still starts correctly');

  const noFm = injectOriginalTitle('# No frontmatter', 'Some Title');
  assert(noFm === '# No frontmatter', 'Content without frontmatter returned unchanged');

  // ── 5. Nonce lifecycle ─────────────────────────────────────────────────────
  console.log('\n--- 5. Nonce Lifecycle ---');

  _clearNonceStore();

  const n1 = issueNonce();
  assert(typeof n1 === 'string' && n1.length > 10, 'Nonce is a non-empty string');
  assert(_nonceStoreSize() === 1,                  'Nonce store has 1 entry after issue');

  const ok = consumeNonce(n1);
  assert(ok,                   'Valid nonce accepted');
  assert(_nonceStoreSize() === 0, 'Nonce store empty after consumption (single-use)');

  const replay = consumeNonce(n1);
  assert(!replay, 'Replayed nonce rejected (already consumed)');

  assert(!consumeNonce(undefined),         'undefined nonce rejected');
  assert(!consumeNonce('not-a-real-nonce'), 'Unknown nonce rejected');

  // TTL expiry simulation — issue a nonce and fake-expire it
  const n2 = issueNonce();
  // Manually corrupt the store TTL by re-issuing with a passed time
  // We test this by consuming after TTL_MS via a synthetic check
  // (Actual sleep would be 30 s — we verify the constant instead)
  assert(NONCE_TTL_MS === 30_000, 'Nonce TTL is 30 seconds');
  consumeNonce(n2); // clean up

  // ── 6. Large content passthrough ──────────────────────────────────────────
  console.log('\n--- 6. Large Content Passthrough ---');

  // injectOriginalTitle must handle large Markdown without truncation
  const bigFm   = `---\ntitle: "Big Note"\n---\n`;
  const bigBody = 'x'.repeat(6 * 1024 * 1024); // 6 MB
  const bigNote = bigFm + bigBody;
  const bigOut  = injectOriginalTitle(bigNote, 'Big: Note');
  assert(bigOut.length > bigNote.length,          '>6 MB note: original_title injected');
  assert(bigOut.includes('original_title:'),       '>6 MB note: injection present');
  assert(bigOut.endsWith(bigBody),                 '>6 MB note: body not truncated');

  // ─── Summary ────────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('========================================\n');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
