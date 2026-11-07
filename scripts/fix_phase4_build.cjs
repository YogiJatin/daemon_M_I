const fs = require('fs');
const path = require('path');

// 1. Fix worker/index.ts
const indexPath = path.join(__dirname, '..', 'worker', 'index.ts');
let indexFile = fs.readFileSync(indexPath, 'utf8');

// Remove misplaced call around line 266
indexFile = indexFile.replace(
  `const result = // Phase 4: Gmail Read-Only Ingress\n    await runGmailIngestionCron(env, scheduledTime).catch((err) => console.error('[GmailIngress] error:', err));\n\n    await runScheduler(env.DB, now, batchSize, { botToken, ownerChatId, pingUrl, dailyCap });`,
  `const result = await runScheduler(env.DB, now, batchSize, { botToken, ownerChatId, pingUrl, dailyCap });`
);

// Add to scheduled() if not already there
if (!indexFile.includes('await runGmailIngestionCron(env, scheduledTime)')) {
  indexFile = indexFile.replace(
    'await runScheduler(env.DB, scheduledTime, undefined, {',
    `// Phase 4 (Block 5): Gmail Read-Only Ingress\n    await runGmailIngestionCron(env, scheduledTime).catch((err) => console.error('[GmailIngress] error:', err));\n\n    await runScheduler(env.DB, scheduledTime, undefined, {`
  );
}
fs.writeFileSync(indexPath, indexFile, 'utf8');
console.log('Fixed worker/index.ts');

// 2. Fix worker/apiRouter.ts
const apiRouterPath = path.join(__dirname, '..', 'worker', 'apiRouter.ts');
let apiRouter = fs.readFileSync(apiRouterPath, 'utf8');

apiRouter = apiRouter.replace(
  'if (!stateRow || new Date(stateRow.expires_at).getTime() < now.getTime()) {',
  'if (!stateRow || new Date((stateRow as any).expires_at).getTime() < now.getTime()) {'
);
apiRouter = apiRouter.replace(
  'code,\n          stateRow.code_verifier,',
  'code,\n          (stateRow as any).code_verifier,'
);
apiRouter = apiRouter.replace(
  '} catch (err) {',
  '} catch (err: any) {'
);
fs.writeFileSync(apiRouterPath, apiRouter, 'utf8');
console.log('Fixed worker/apiRouter.ts');

// 3. Fix worker/gmailIngestion.ts
const gmailIngestPath = path.join(__dirname, '..', 'worker', 'gmailIngestion.ts');
let gmailIngest = fs.readFileSync(gmailIngestPath, 'utf8');

gmailIngest = gmailIngest.replace(
  `import { callAIWithFailover } from './aiAdapter';`,
  `import { AIAdapter } from './aiAdapter';`
);

gmailIngest = gmailIngest.replace(
  `  const ist = getISTDateParts(now);\n  if (ist.hour >= 23 || ist.hour < 7) {`,
  `  const ist = getISTDateParts(now);\n  const hr = parseInt(ist.hours, 10);\n  if (hr >= 23 || hr < 7) {`
);

gmailIngest = gmailIngest.replace(
  `    let aiRes: any;\n    try {\n      aiRes = await callAIWithFailover(env, [\n        { role: 'user', content: prompt }\n      ], {\n        maxTokens: 500,\n        temperature: 0.1,\n      });\n    } catch {\n      // AI call failed; leave message unprocessed so it retries\n      continue;\n    }`,
  `    let aiRes: any;\n    try {\n      const adapter = new AIAdapter(env, env.DB);\n      aiRes = await adapter.execute({\n        prompt,\n        privacyClass: 'personal',\n        maxTokens: 500,\n        temperature: 0.1,\n      });\n    } catch {\n      // AI call failed; leave message unprocessed so it retries\n      continue;\n    }`
);

// Fix untyped .first<{ ... }>() to (await ...first()) as any
gmailIngest = gmailIngest.replace(
  `.first<{ status: string; is_active: number }>()`,
  `.first() as any`
);
gmailIngest = gmailIngest.replace(
  `.first<{ cnt: number }>()`,
  `.first() as any`
);

fs.writeFileSync(gmailIngestPath, gmailIngest, 'utf8');
console.log('Fixed worker/gmailIngestion.ts');
