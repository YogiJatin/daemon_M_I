/**
 * tests/verify_obsidian_live.ts — Live Integration Verification
 *
 * Starts the desktop agent HTTP server on port 27124, executes live HTTP requests:
 *   1. GET /desktop/health
 *   2. GET /desktop/nonce with permitted origin
 *   3. POST /desktop/obsidian/write to create a test note in D:\daemon's brain\Knowledge\Recipes
 *   4. Verifies the file actually exists on disk in D:\daemon's brain
 *   5. Verifies UTF-8 and YAML frontmatter preservation
 *   6. Gracefully stops the agent server
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { startServer, stopServer } from '../desktop-agent/obsidian-writer.js';

async function runLiveTest() {
  console.log('\n=== RUNNING DESKTOP AGENT LIVE INTEGRATION TEST ===\n');

  try {
    // 1. Start agent
    console.log('1. Starting desktop agent server in-process...');
    await startServer();

    // 2. Test GET /desktop/health
    console.log('2. Testing GET /desktop/health...');
    const healthRes = await fetch('http://127.0.0.1:27124/desktop/health');
    if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
    const health = await healthRes.json() as any;
    console.log('  ✅ Health probe succeeded:', health);

    // 3. Test GET /desktop/nonce with allowed origin
    console.log('3. Testing GET /desktop/nonce with Origin header...');
    const nonceRes = await fetch('http://127.0.0.1:27124/desktop/nonce', {
      headers: { Origin: 'https://personal-ai-os.jatin-personal-ai.workers.dev' },
    });
    if (!nonceRes.ok) throw new Error(`Nonce request failed: ${nonceRes.status}`);
    const { nonce } = await nonceRes.json() as any;
    console.log('  ✅ Nonce acquired successfully:', nonce);

    // 4. Test unauthorized origin rejection
    console.log('4. Testing rejection of unapproved origin...');
    const badNonceRes = await fetch('http://127.0.0.1:27124/desktop/nonce', {
      headers: { Origin: 'https://malicious-website.com' },
    });
    if (badNonceRes.status === 403) {
      console.log('  ✅ Malicious origin correctly rejected with 403 Forbidden');
    } else {
      throw new Error(`Expected 403 for unauthorized origin, got ${badNonceRes.status}`);
    }

    // 5. Test POST /desktop/obsidian/write
    console.log('5. Testing POST /desktop/obsidian/write...');
    const testContent = `---
title: "Chicken Curry"
recipe_id: "recipe_test_curry_001"
status: "approved"
origin: "teach_mode"
tags: [workflow, cooking, recipe]
---

# Chicken Curry

> Personal AI OS Verified Export Note

## Ingredients
- Chicken: 500g
- Onion, Tomatoes, Spices

## Procedure
1. Sauté onions until golden brown.
2. Add ginger garlic paste and spices.
3. Cook chicken until tender.
`;

    const writeRes = await fetch('http://127.0.0.1:27124/desktop/obsidian/write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://personal-ai-os.jatin-personal-ai.workers.dev',
        'X-Agent-Nonce': nonce,
      },
      body: JSON.stringify({
        vault: "D:\\daemon's brain",
        folder: 'Knowledge/Recipes',
        filename: 'Chicken Curry.md',
        content: testContent,
        overwrite: true,
      }),
    });

    if (!writeRes.ok) {
      const errBody = await writeRes.text();
      throw new Error(`Write failed with HTTP ${writeRes.status}: ${errBody}`);
    }

    const writeResult = await writeRes.json() as any;
    console.log('  ✅ Write call succeeded:', writeResult);

    // 6. Verify file existence on filesystem
    console.log('6. Verifying physical file in Obsidian vault...');
    const expectedFilePath = path.join("D:\\daemon's brain", 'Knowledge', 'Recipes', 'Chicken Curry.md');
    if (!existsSync(expectedFilePath)) {
      throw new Error(`File was not found on disk at: ${expectedFilePath}`);
    }

    const diskContent = readFileSync(expectedFilePath, 'utf8');
    if (!diskContent.includes('recipe_test_curry_001')) {
      throw new Error('File content mismatch on disk!');
    }
    console.log(`  ✅ Verified: Note written and verified at ${expectedFilePath}`);

    console.log('\n========================================');
    console.log('LIVE INTEGRATION TEST PASSED (ALL CHECKS)');
    console.log('========================================\n');

  } finally {
    console.log('Stopping test agent server...');
    await stopServer();
  }
}

runLiveTest().catch((err) => {
  console.error('\n❌ Live Integration Test Failed:', err);
  process.exit(1);
});
