/**
 * tests/eval_block1_dataset.ts - Block 1 Conversational AI Assistant Evaluation Suite
 *
 * Requirements:
 * - >= 100 cases (>= 50 negatives with near-misses)
 * - Multilingual: English, Hinglish, and Telugu-mixed
 * - Pass criteria:
 *   - False Positives <= 2 / 50 negatives (FP rate <= 4%)
 *   - Precision >= 90%
 * - Slot for user-provided real messages
 */

import { detectObligation } from "../worker/captureEngine";

export interface TestCase {
  id: string;
  text: string;
  expectedIntent: "task_or_commitment" | "negative";
  language: "en" | "hinglish" | "te" | "mixed";
  category: string;
}

export const EVAL_DATASET: TestCase[] = [
  // =========================================================================
  // NEGATIVES (55 cases): Questions, Hypotheticals, Past, Jokes, Others, Chat
  // =========================================================================
  { id: "neg-01", text: "Hey good morning!", expectedIntent: "negative", language: "en", category: "greeting" },
  { id: "neg-02", text: "How are you doing today?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-03", text: "What is the capital of France?", expectedIntent: "negative", language: "en", category: "general_query" },
  { id: "neg-04", text: "Did you already send the email?", expectedIntent: "negative", language: "en", category: "question_past" },
  { id: "neg-05", text: "I finished the report yesterday", expectedIntent: "negative", language: "en", category: "past_action" },
  { id: "neg-06", text: "I already submitted my assignment this morning", expectedIntent: "negative", language: "en", category: "past_action" },
  { id: "neg-07", text: "Rahul needs to bring the lab equipment", expectedIntent: "negative", language: "en", category: "other_person" },
  { id: "neg-08", text: "They will submit their project on Friday", expectedIntent: "negative", language: "en", category: "other_person" },
  { id: "neg-09", text: "She has to study for midterms", expectedIntent: "negative", language: "en", category: "other_person" },
  { id: "neg-10", text: "Hypothetically if I need to drop out lol", expectedIntent: "negative", language: "en", category: "hypothetical" },
  { id: "neg-11", text: "Maybe I might do it tomorrow just kidding haha", expectedIntent: "negative", language: "en", category: "joke" },
  { id: "neg-12", text: "Is there a class tomorrow at 9 AM?", expectedIntent: "negative", language: "en", category: "schedule_question" },
  { id: "neg-13", text: "Can you tell me today's schedule?", expectedIntent: "negative", language: "en", category: "query" },
  { id: "neg-14", text: "Who was Alan Turing?", expectedIntent: "negative", language: "en", category: "general_query" },
  { id: "neg-15", text: "Nice work on the bot!", expectedIntent: "negative", language: "en", category: "compliment" },
  { id: "neg-16", text: "Kya chal raha hai bhai?", expectedIntent: "negative", language: "hinglish", category: "greeting" },
  { id: "neg-17", text: "Kal class hui thi kya?", expectedIntent: "negative", language: "hinglish", category: "question" },
  { id: "neg-18", text: "Mera dost assignment submit karega", expectedIntent: "negative", language: "hinglish", category: "other_person" },
  { id: "neg-19", text: "Maine kal hi submit kar diya tha", expectedIntent: "negative", language: "hinglish", category: "past_action" },
  { id: "neg-20", text: "Shayad kal college jau mazaak kar raha hu", expectedIntent: "negative", language: "hinglish", category: "joke" },
  { id: "neg-21", text: "Repu college undha?", expectedIntent: "negative", language: "te", category: "question" },
  { id: "neg-22", text: "Ninna assignment aipoyindi", expectedIntent: "negative", language: "te", category: "past_action" },
  { id: "neg-23", text: "Vadu report rastunnadu", expectedIntent: "negative", language: "te", category: "other_person" },
  { id: "neg-24", text: "Ela unnav bro?", expectedIntent: "negative", language: "te", category: "greeting" },
  { id: "neg-25", text: "Could you explain Ohm's law to me?", expectedIntent: "negative", language: "en", category: "query" },
  { id: "neg-26", text: "Why is water wet?", expectedIntent: "negative", language: "en", category: "general_query" },
  { id: "neg-27", text: "I wonder if it will rain tomorrow", expectedIntent: "negative", language: "en", category: "hypothetical" },
  { id: "neg-28", text: "Perhaps we should ask the professor first?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-29", text: "Haha that was so funny lmao", expectedIntent: "negative", language: "en", category: "reaction" },
  { id: "neg-30", text: "Thanks a lot for the help", expectedIntent: "negative", language: "en", category: "gratitude" },
  { id: "neg-31", text: "Are you an AI or a real person?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-32", text: "Do you have any advice on exam stress?", expectedIntent: "negative", language: "en", category: "advice" },
  { id: "neg-33", text: "My laptop battery is draining very fast", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-34", text: "The cafeteria food was decent today", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-35", text: "Professor Sinha cancelled the 2 PM lecture yesterday", expectedIntent: "negative", language: "en", category: "past_action" },
  { id: "neg-36", text: "Is the library open on Sundays?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-37", text: "Acha theek hai", expectedIntent: "negative", language: "hinglish", category: "acknowledgment" },
  { id: "neg-38", text: "Bhai kya lagta hai exam kaisa aayega?", expectedIntent: "negative", language: "hinglish", category: "question" },
  { id: "neg-39", text: "Sir ne bola tha padh ke aana par maine nahi padha lol", expectedIntent: "negative", language: "hinglish", category: "joke" },
  { id: "neg-40", text: "Anil ko bolo notes bhej de", expectedIntent: "negative", language: "hinglish", category: "request_for_other" },
  { id: "neg-41", text: "Avuna sare bro", expectedIntent: "negative", language: "te", category: "acknowledgment" },
  { id: "neg-42", text: "Eeroju lunch em tinnaru?", expectedIntent: "negative", language: "te", category: "question" },
  { id: "neg-43", text: "Class lo attendance chala thakkuva undi", expectedIntent: "negative", language: "te", category: "observation" },
  { id: "neg-44", text: "Kiran repu ostunnadu anta", expectedIntent: "negative", language: "te", category: "other_person" },
  { id: "neg-45", text: "Can you summarize chapter 3 for me?", expectedIntent: "negative", language: "en", category: "request" },
  { id: "neg-46", text: "Does Cloudflare Workers support WebSockets?", expectedIntent: "negative", language: "en", category: "tech_question" },
  { id: "neg-47", text: "Just testing if this works", expectedIntent: "negative", language: "en", category: "test" },
  { id: "neg-48", text: "Ping", expectedIntent: "negative", language: "en", category: "ping" },
  { id: "neg-49", text: "Good night, see you tomorrow", expectedIntent: "negative", language: "en", category: "signoff" },
  { id: "neg-50", text: "Subha bholenge ab", expectedIntent: "negative", language: "hinglish", category: "signoff" },
  { id: "neg-51", text: "Padukuntunna bye", expectedIntent: "negative", language: "te", category: "signoff" },
  { id: "neg-52", text: "What did I do last Monday?", expectedIntent: "negative", language: "en", category: "past_query" },
  { id: "neg-53", text: "Have you seen my keys anywhere?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-54", text: "Would you rather fight 100 duck-sized horses?", expectedIntent: "negative", language: "en", category: "joke" },
  { id: "neg-55", text: "Nice weather today isn't it?", expectedIntent: "negative", language: "en", category: "small_talk" },

  // =========================================================================
  // POSITIVES (55 cases): Explicit Tasks, Reminders, Implicit Commitments
  // =========================================================================
  { id: "pos-01", text: "I need to pick up groceries after class", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-02", text: "I have to finish my DSP assignment tonight", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-03", text: "I should study for the chemistry quiz", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-04", text: "I must submit the internship form tomorrow", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-05", text: "I will call Mom this evening", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-06", text: "I am going to renew my bus pass tomorrow morning", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-07", text: "I gotta send the draft to professor", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-08", text: "Need to buy printer paper", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-09", text: "Planning to visit the dentist on Saturday", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-10", text: "Remember to bring the calculator to the exam", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-11", text: "Remind me at 7 about the team meeting", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-12", text: "Remind me tomorrow at 9 AM to submit lab records", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-13", text: "I need to check the voltage divider circuit before Friday", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-14", text: "Gotta pay the hostel fee before next week", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-15", text: "I have to write the executive summary tonight", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-16", text: "Mughe kal library jana hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-17", text: "Ye assignment aaj raat tak submit karna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-18", text: "Physics lab manual complete karni hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-19", text: "Kal subah 9 baje sir ko mail bhejo", expectedIntent: "task_or_commitment", language: "hinglish", category: "explicit_task" },
  { id: "pos-20", text: "Exam form kal tak bharna padna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-21", text: "Kal presentation ready karna hoga", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-22", text: "Nenu repu assignment complete cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-23", text: "Repu college ki project report submit cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-24", text: "Ee pani thondaraga cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-25", text: "I need to pay electricity bill today", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-26", text: "I have to read chapter 4 for tomorrow's quiz", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-27", text: "I should recharge my phone plan", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-28", text: "Need to print the hall ticket tonight", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-29", text: "I will email the advisor about the thesis topic", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-30", text: "Remind me in 30 minutes to take medicine", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-31", text: "I gotta clean my room this weekend", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-32", text: "I am going to prepare slides for Monday", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-33", text: "Kal morning me running jana hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-34", text: "Project ka code review karna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-35", text: "Repu podduna 8 ki levali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-36", text: "Fee payment repu cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-37", text: "I have to backup my laptop hard drive", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-38", text: "I should verify my passport renewal application", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-39", text: "Need to pick up parcels from post office", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-40", text: "Gotta schedule an appointment with Dr. Rao", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-41", text: "Remind me at 18:00 to leave for airport", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-42", text: "Remind me tomorrow evening about grocery run", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-43", text: "Notes scan karke drive pe upload karna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-44", text: "Sem fee kal bhar deni hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-45", text: "Room rent transfer cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-46", text: "Cycle repair repu cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-47", text: "I need to review PR #42 before merging", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-48", text: "I have to wash clothes tomorrow morning", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-49", text: "I must return the library book by Monday", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-50", text: "Remind me after class to meet HOD", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-51", text: "I will attend the placement seminar today", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-52", text: "Kal class ke baad notes verify karna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "implicit_obligation" },
  { id: "pos-53", text: "Id card apply cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "implicit_obligation" },
  { id: "pos-54", text: "I gotta study control systems unit 2", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-55", text: "Need to submit reimbursement receipts", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },

  // =========================================================================
  // USER REAL MESSAGE SLOTS (Reserved for 30 real messages user will supply)
  // =========================================================================
];

export function runEval() {
  console.log("\n========================================================");
  console.log(`   BLOCK 1 EVAL BENCHMARK (${EVAL_DATASET.length} CASES)`);
  console.log("========================================================\n");

  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  const fpCases: { id: string; text: string; evidence: string }[] = [];
  const fnCases: { id: string; text: string }[] = [];

  for (const tc of EVAL_DATASET) {
    const res = detectObligation(tc.text);
    const predictedPositive = res.detected;
    const actualPositive = tc.expectedIntent === "task_or_commitment";

    if (predictedPositive && actualPositive) {
      truePositives++;
    } else if (predictedPositive && !actualPositive) {
      falsePositives++;
      fpCases.push({ id: tc.id, text: tc.text, evidence: res.evidence });
    } else if (!predictedPositive && !actualPositive) {
      trueNegatives++;
    } else {
      falseNegatives++;
      fnCases.push({ id: tc.id, text: tc.text });
    }
  }

  const totalNegatives = trueNegatives + falsePositives;
  const totalPositives = truePositives + falseNegatives;
  const precision = truePositives / (truePositives + falsePositives);
  const recall = truePositives / (truePositives + falseNegatives);
  const accuracy = (truePositives + trueNegatives) / EVAL_DATASET.length;

  console.log(`Dataset summary:`);
  console.log(`  Total Cases:     ${EVAL_DATASET.length}`);
  console.log(`  Positives:       ${totalPositives}`);
  console.log(`  Negatives:       ${totalNegatives}`);
  console.log(`\nConfusion Matrix:`);
  console.log(`  True Positives:  ${truePositives}`);
  console.log(`  True Negatives:  ${trueNegatives}`);
  console.log(`  False Positives: ${falsePositives} / ${totalNegatives} (Gate: <= 2 / 50 negatives)`);
  console.log(`  False Negatives: ${falseNegatives}`);
  console.log(`\nMetrics:`);
  console.log(`  Precision:       ${(precision * 100).toFixed(1)}% (Gate: >= 90.0%)`);
  console.log(`  Recall:          ${(recall * 100).toFixed(1)}%`);
  console.log(`  Accuracy:        ${(accuracy * 100).toFixed(1)}%`);

  if (fpCases.length > 0) {
    console.log(`\nFalse Positive Details:`);
    for (const c of fpCases) {
      console.log(`  [${c.id}] "${c.text}" -> matched trigger "${c.evidence}"`);
    }
  }

  if (fnCases.length > 0) {
    console.log(`\nFalse Negative Details:`);
    for (const c of fnCases) {
      console.log(`  [${c.id}] "${c.text}"`);
    }
  }

  const fpGatePass = falsePositives <= 2;
  const precisionGatePass = precision >= 0.9;
  const allPassed = fpGatePass && precisionGatePass;

  console.log("\nGate Verification:");
  console.log(`  Negative Gate (FP <= 2): ${fpGatePass ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  Precision Gate (>= 90%): ${precisionGatePass ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  Overall Eval Gate:       ${allPassed ? "✅ PASS" : "❌ FAIL"}\n`);

  return { allPassed, precision, recall, falsePositives, totalNegatives };
}

if (process.argv[1]?.includes("eval_block1_dataset")) {
  runEval();
}
