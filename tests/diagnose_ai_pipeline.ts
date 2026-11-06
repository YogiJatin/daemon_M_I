/**
 * tests/diagnose_ai_pipeline.ts — End-to-End Diagnostic of Ingress & AI Pipeline
 */

import { createMockD1 } from './mockD1';
import { InputRouter } from '../worker/inputRouter';
import { VoiceIngress } from '../worker/voiceIngress';
import { OCRIngress } from '../worker/ocrIngress';
import { DocumentIngress } from '../worker/documentIngress';
import { AICapabilities } from '../worker/aiCapabilities';
import { listTaskProposals, confirmProposal } from '../worker/inboxService';

async function diagnose() {
  console.log('\n=== DIAGNOSING INGRESS & AI PIPELINE ===\n');

  const db = createMockD1();

  // Diagnostic 1: Direct text input to InputRouter
  console.log('1. Testing InputRouter with text: "Buy milk tomorrow 18:00 | Project Groceries"');
  try {
    const textRes = await InputRouter.routeInput(
      db,
      {
        source: 'web',
        rawType: 'text',
        payload: 'Buy milk tomorrow 18:00 | Project Groceries',
      },
      {}
    );
    console.log('  ✅ Text ingress success! Created proposal:', textRes.proposalId);
    console.log('     Candidate title:', textRes.interpretation.candidateTitle);
    console.log('     Category:', textRes.interpretation.category);
    console.log('     Proposed local date:', textRes.interpretation.proposedLocalDate);
    console.log('     Proposed local time:', textRes.interpretation.proposedLocalTime);
  } catch (err: any) {
    console.error('  ❌ Text ingress failed:', err.message);
  }

  // Diagnostic 2: Task proposals table check
  console.log('\n2. Testing Inbox / Proposal retrieval from D1');
  try {
    const listRes = await listTaskProposals(db, 'pending');
    console.log(`  ✅ Retrieved ${listRes.total} pending proposal(s) from inbox:`);
    listRes.proposals.forEach((p) => {
      console.log(`     - [${p.id}] "${p.title}" (status: ${p.status}, priority: ${p.priority})`);
    });

    if (listRes.proposals.length > 0) {
      const p = listRes.proposals[0];
      console.log(`\n3. Testing confirmation of proposal [${p.id}]`);
      const confRes = await confirmProposal(db, p.id);
      console.log('  ✅ Proposal confirmed! Created task:', confRes.task?.id);
    }
  } catch (err: any) {
    console.error('  ❌ Proposal retrieval/confirmation failed:', err.message);
  }

  // Diagnostic 4: Voice Ingress Default Provider
  console.log('\n4. Inspecting Voice Ingress default provider with empty env vs populated env');
  const emptyVoice = VoiceIngress.createDefault({});
  console.log('   Empty env voice provider:', (emptyVoice as any).provider?.name);

  const populatedVoice = VoiceIngress.createDefault({
    GROQ_API_KEY_1: 'gsk_test',
    AI: {},
  });
  console.log('   Populated env (GROQ_API_KEY_1 only):', (populatedVoice as any).provider?.name);
  console.log('   Notice: If GROQ_API_KEY_1 is provided but code checks GROQ_API_KEY, it selects:', (populatedVoice as any).provider?.name);

  // Diagnostic 5: OCR Ingress Default Provider
  console.log('\n5. Inspecting OCR Ingress default provider');
  const emptyOcr = OCRIngress.createDefault({});
  console.log('   Empty env OCR provider:', (emptyOcr as any).provider?.name);

  // Diagnostic 6: AI Capabilities Execution
  console.log('\n6. Testing AICapabilities with default mock fallback');
  try {
    const aiCaps = new AICapabilities({ AI_PROVIDER_ORDER: 'mock' }, db);
    const tbRes = await aiCaps.taskBreakdown({ title: 'Build rocket ship' });
    console.log('   ✅ taskBreakdown success! Provider:', tbRes.provider);
    console.log('      Subtasks generated:', (tbRes.data as any)?.subtasks?.length);

    const snRes = await aiCaps.suggestNext('What should I study?');
    console.log('   ✅ suggestNext success! Next action:', (snRes.data as any)?.next_action);

    const prRes = await aiCaps.prioritize();
    console.log('   ✅ prioritize success! Summary:', (prRes.data as any)?.summary);

    const wpRes = await aiCaps.weeklyPlan();
    console.log('   ✅ weeklyPlan success! Proposals:', (wpRes.data as any)?.proposals?.length);
  } catch (err: any) {
    console.error('   ❌ AICapabilities failed:', err.message);
  }

  console.log('\n=== DIAGNOSIS COMPLETE ===\n');
}

diagnose().catch(console.error);
