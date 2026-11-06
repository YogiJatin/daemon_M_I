/**
 * tests/eval_block2_dataset.ts - Block 2 Conversational & Capture Evaluation Suite
 *
 * Requirements:
 * - >= 140 cases (>= 80 negatives with 30 near-misses)
 * - Multilingual: English, Hinglish, and Telugu-mixed
 * - Positives: explicit tasks, explicit reminders, implicit commitments, schedule exceptions
 * - Negatives: greetings, questions, bodily states, wishes/routines, past actions, other people, jokes
 * - Pass criteria:
 *   - False Positives <= 3 / 80+ negatives (FP rate <= 4%)
 *   - Precision >= 90%
 *   - Recall >= 90%
 * - SHA-256 hash of dataset printed
 * - Includes slot for tests/eval_real_messages.json
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  // NEGATIVES: 85 cases (including 35 near-misses)
  // =========================================================================

  // --- Near-misses: Bodily states (10 cases) ---
  { id: "neg-01", text: "I need to sleep early tonight", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-02", text: "I am so tired today", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-03", text: "I have to take a nap right now", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-04", text: "I'm exhausted from yesterday", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-05", text: "I feel sick and need some rest", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-06", text: "I have a terrible headache", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-07", text: "I need some sleep bro", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-08", text: "I'm really hungry right now", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-09", text: "I am feeling sleepy in class", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },
  { id: "neg-10", text: "I just need to rest my eyes", expectedIntent: "negative", language: "en", category: "near_miss_bodily" },

  // --- Near-misses: Wishes & General Routines (10 cases) ---
  { id: "neg-11", text: "I wish I could visit Paris someday", expectedIntent: "negative", language: "en", category: "near_miss_wish" },
  { id: "neg-12", text: "I want to visit Tokyo one day", expectedIntent: "negative", language: "en", category: "near_miss_wish" },
  { id: "neg-13", text: "I usually drink coffee in the morning", expectedIntent: "negative", language: "en", category: "near_miss_routine" },
  { id: "neg-14", text: "I typically wake up around 7 AM", expectedIntent: "negative", language: "en", category: "near_miss_routine" },
  { id: "neg-15", text: "Everyday I see people rushing to college", expectedIntent: "negative", language: "en", category: "near_miss_routine" },
  { id: "neg-16", text: "I wish we had no exams", expectedIntent: "negative", language: "en", category: "near_miss_wish" },
  { id: "neg-17", text: "Someday I will learn guitar", expectedIntent: "negative", language: "en", category: "near_miss_wish" },
  { id: "neg-18", text: "I usually study in the library on Fridays", expectedIntent: "negative", language: "en", category: "near_miss_routine" },
  { id: "neg-19", text: "One day I want to build a rocket", expectedIntent: "negative", language: "en", category: "near_miss_wish" },
  { id: "neg-20", text: "I wish it would stop raining", expectedIntent: "negative", language: "en", category: "near_miss_wish" },

  // --- Near-misses: Other people's obligations (8 cases) ---
  { id: "neg-21", text: "Rahul needs to bring the lab equipment", expectedIntent: "negative", language: "en", category: "near_miss_other" },
  { id: "neg-22", text: "They will submit their project on Friday", expectedIntent: "negative", language: "en", category: "near_miss_other" },
  { id: "neg-23", text: "She has to study for midterms", expectedIntent: "negative", language: "en", category: "near_miss_other" },
  { id: "neg-24", text: "He needs to submit the report", expectedIntent: "negative", language: "en", category: "near_miss_other" },
  { id: "neg-25", text: "Mera dost assignment submit karega", expectedIntent: "negative", language: "hinglish", category: "near_miss_other" },
  { id: "neg-26", text: "Vadu report rastunnadu", expectedIntent: "negative", language: "te", category: "near_miss_other" },
  { id: "neg-27", text: "Kiran repu ostunnadu anta", expectedIntent: "negative", language: "te", category: "near_miss_other" },
  { id: "neg-28", text: "Anil should send the slides", expectedIntent: "negative", language: "en", category: "near_miss_other" },

  // --- Near-misses: Past actions already completed (7 cases) ---
  { id: "neg-29", text: "I finished the report yesterday", expectedIntent: "negative", language: "en", category: "near_miss_past" },
  { id: "neg-30", text: "I already submitted my assignment this morning", expectedIntent: "negative", language: "en", category: "near_miss_past" },
  { id: "neg-31", text: "Maine kal hi submit kar diya tha", expectedIntent: "negative", language: "hinglish", category: "near_miss_past" },
  { id: "neg-32", text: "Ninna assignment aipoyindi", expectedIntent: "negative", language: "te", category: "near_miss_past" },
  { id: "neg-33", text: "Professor Sinha cancelled the 2 PM lecture yesterday", expectedIntent: "negative", language: "en", category: "near_miss_past" },
  { id: "neg-34", text: "I just did that an hour ago", expectedIntent: "negative", language: "en", category: "near_miss_past" },
  { id: "neg-35", text: "Already done with the homework", expectedIntent: "negative", language: "en", category: "near_miss_past" },

  // --- General Negatives: Questions & Hypotheticals (20 cases) ---
  { id: "neg-36", text: "Did you already send the email?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-37", text: "Is there a class tomorrow at 9 AM?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-38", text: "Can you tell me today's schedule?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-39", text: "What is the capital of France?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-40", text: "Could you explain Ohm's law to me?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-41", text: "Why is water wet?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-42", text: "Is the library open on Sundays?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-43", text: "Are you an AI or a real person?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-44", text: "Do you have any advice on exam stress?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-45", text: "Hypothetically if I need to drop out lol", expectedIntent: "negative", language: "en", category: "hypothetical" },
  { id: "neg-46", text: "Maybe I might do it tomorrow just kidding haha", expectedIntent: "negative", language: "en", category: "joke" },
  { id: "neg-47", text: "I wonder if it will rain tomorrow", expectedIntent: "negative", language: "en", category: "hypothetical" },
  { id: "neg-48", text: "Perhaps we should ask the professor first?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-49", text: "Kal class hui thi kya?", expectedIntent: "negative", language: "hinglish", category: "question" },
  { id: "neg-50", text: "Bhai kya lagta hai exam kaisa aayega?", expectedIntent: "negative", language: "hinglish", category: "question" },
  { id: "neg-51", text: "Repu college undha?", expectedIntent: "negative", language: "te", category: "question" },
  { id: "neg-52", text: "Eeroju lunch em tinnaru?", expectedIntent: "negative", language: "te", category: "question" },
  { id: "neg-53", text: "Can we submit later?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-54", text: "Should I take notes today?", expectedIntent: "negative", language: "en", category: "question" },
  { id: "neg-55", text: "Will the lab be open at 5?", expectedIntent: "negative", language: "en", category: "question" },

  // --- General Negatives: Greetings, compliments, chit-chat (30 cases) ---
  { id: "neg-56", text: "Hey good morning!", expectedIntent: "negative", language: "en", category: "greeting" },
  { id: "neg-57", text: "How are you doing today?", expectedIntent: "negative", language: "en", category: "greeting" },
  { id: "neg-58", text: "Nice work on the bot!", expectedIntent: "negative", language: "en", category: "compliment" },
  { id: "neg-59", text: "Kya chal raha hai bhai?", expectedIntent: "negative", language: "hinglish", category: "greeting" },
  { id: "neg-60", text: "Ela unnav bro?", expectedIntent: "negative", language: "te", category: "greeting" },
  { id: "neg-61", text: "Haha that was so funny lmao", expectedIntent: "negative", language: "en", category: "reaction" },
  { id: "neg-62", text: "Thanks a lot for the help", expectedIntent: "negative", language: "en", category: "gratitude" },
  { id: "neg-63", text: "My laptop battery is draining very fast", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-64", text: "The cafeteria food was decent today", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-65", text: "Acha theek hai", expectedIntent: "negative", language: "hinglish", category: "acknowledgment" },
  { id: "neg-66", text: "Avuna sare bro", expectedIntent: "negative", language: "te", category: "acknowledgment" },
  { id: "neg-67", text: "Class lo attendance chala thakkuva undi", expectedIntent: "negative", language: "te", category: "observation" },
  { id: "neg-68", text: "Good night sweet dreams", expectedIntent: "negative", language: "en", category: "greeting" },
  { id: "neg-69", text: "See you tomorrow in college", expectedIntent: "negative", language: "en", category: "chit_chat" },
  { id: "neg-70", text: "Weather looks really cloudy today", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-71", text: "That movie was awesome", expectedIntent: "negative", language: "en", category: "opinion" },
  { id: "neg-72", text: "No way that actually happened", expectedIntent: "negative", language: "en", category: "reaction" },
  { id: "neg-73", text: "Okay got it thanks", expectedIntent: "negative", language: "en", category: "acknowledgment" },
  { id: "neg-74", text: "The bus was so crowded today", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-75", text: "Maza aa gaya aaj to", expectedIntent: "negative", language: "hinglish", category: "reaction" },
  { id: "neg-76", text: "Kallu thirugutunnayi", expectedIntent: "negative", language: "te", category: "observation" },
  { id: "neg-77", text: "Chala bore ga undi", expectedIntent: "negative", language: "te", category: "observation" },
  { id: "neg-78", text: "Awesome, appreciate it", expectedIntent: "negative", language: "en", category: "gratitude" },
  { id: "neg-79", text: "Sure thing bro", expectedIntent: "negative", language: "en", category: "acknowledgment" },
  { id: "neg-80", text: "Just chilling at home", expectedIntent: "negative", language: "en", category: "chit_chat" },
  { id: "neg-81", text: "Sir was in a bad mood today", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-82", text: "Hahaha no way lol", expectedIntent: "negative", language: "en", category: "reaction" },
  { id: "neg-83", text: "Bohot traffic tha raste mein", expectedIntent: "negative", language: "hinglish", category: "observation" },
  { id: "neg-84", text: "Everything is so expensive nowadays", expectedIntent: "negative", language: "en", category: "observation" },
  { id: "neg-85", text: "Catch you later!", expectedIntent: "negative", language: "en", category: "greeting" },

  // =========================================================================
  // POSITIVES: 60 cases (Explicit tasks, reminders, commitments, anchors)
  // =========================================================================

  // --- English Explicit & Implicit (25 cases) ---
  { id: "pos-01", text: "I need to submit the assignment by 5pm", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-02", text: "I have to email Professor Rao before tomorrow", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-03", text: "I must finish the project report tonight", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-04", text: "I should pay the semester fee today", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-05", text: "I will call the bank at 10 AM", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-06", text: "I am going to prepare the presentation slides", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-07", text: "I'm going to buy groceries after class", expectedIntent: "task_or_commitment", language: "en", category: "anchor_after_class" },
  { id: "pos-08", text: "I gotta complete the lab record before Monday", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-09", text: "planning to study chapter 4 this evening", expectedIntent: "task_or_commitment", language: "en", category: "anchor_evening" },
  { id: "pos-10", text: "need to return the library book by Friday", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-11", text: "have to finish writing unit tests", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-12", text: "remember to print admit card tomorrow morning", expectedIntent: "task_or_commitment", language: "en", category: "anchor_morning" },
  { id: "pos-13", text: "remind me to take medication at 9 PM", expectedIntent: "task_or_commitment", language: "en", category: "explicit_reminder" },
  { id: "pos-14", text: "remind me to call Mom reaching home", expectedIntent: "task_or_commitment", language: "en", category: "anchor_reaching_home" },
  { id: "pos-15", text: "I have to pack my bag leaving home", expectedIntent: "task_or_commitment", language: "en", category: "anchor_leaving_home" },
  { id: "pos-16", text: "need to meet professor before first class", expectedIntent: "task_or_commitment", language: "en", category: "anchor_before_class" },
  { id: "pos-17", text: "I must review code leaving college", expectedIntent: "task_or_commitment", language: "en", category: "anchor_leaving_college" },
  { id: "pos-18", text: "I will submit the lab report by 4pm", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },
  { id: "pos-19", text: "I need to recharge metro card in an hour", expectedIntent: "task_or_commitment", language: "en", category: "relative_time" },
  { id: "pos-20", text: "remind me to check oven in 20 minutes", expectedIntent: "task_or_commitment", language: "en", category: "relative_time" },
  { id: "pos-21", text: "I gotta submit assignment today 14:00", expectedIntent: "task_or_commitment", language: "en", category: "explicit_time" },
  { id: "pos-22", text: "I will send invoice tomorrow morning", expectedIntent: "task_or_commitment", language: "en", category: "anchor_morning" },
  { id: "pos-23", text: "I have to clean room this evening", expectedIntent: "task_or_commitment", language: "en", category: "anchor_evening" },
  { id: "pos-24", text: "planning to do laundry after class", expectedIntent: "task_or_commitment", language: "en", category: "anchor_after_class" },
  { id: "pos-25", text: "remember to submit feedback form", expectedIntent: "task_or_commitment", language: "en", category: "implicit_obligation" },

  // --- Hinglish Obligations (20 cases) ---
  { id: "pos-26", text: "Mujhe assignment submit karni hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-27", text: "Kal subah college jana hai 8 baje", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-28", text: "Aaj sham ko project presentation ready karna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-29", text: "Fee payment deni hai deadline se pehle", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-30", text: "Notes sir ko bhejo sham tak", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-31", text: "Kal subah jaldi uthna hoga", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-32", text: "Record book complete karni padegi", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-33", text: "Sir ko email bhejo class ke baad", expectedIntent: "task_or_commitment", language: "hinglish", category: "anchor_after_class" },
  { id: "pos-34", text: "Library book return karni hai kal", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-35", text: "Aaj raat ko exam ke liye padna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-36", text: "Form fill karna hoga aaj hi", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-37", text: "Printout nikalna hai subah", expectedIntent: "task_or_commitment", language: "hinglish", category: "anchor_morning" },
  { id: "pos-38", text: "Ghar pahuchte hi call karna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "anchor_reaching_home" },
  { id: "pos-39", text: "College chhodte waqt umbrella le lena", expectedIntent: "task_or_commitment", language: "hinglish", category: "anchor_leaving_college" },
  { id: "pos-40", text: "Pehle lecture se pehle assignment print karo", expectedIntent: "task_or_commitment", language: "hinglish", category: "anchor_before_class" },
  { id: "pos-41", text: "Bhai assignment submit karna hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-42", text: "Kal viva ke liye prepare karna hoga", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-43", text: "Laptop repair ke liye dena hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-44", text: "Sir se sign karwana hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },
  { id: "pos-45", text: "Mujhe aaj workout jana hai", expectedIntent: "task_or_commitment", language: "hinglish", category: "hinglish_obligation" },

  // --- Telugu & Telugu-Mixed Obligations (15 cases) ---
  { id: "pos-46", text: "Nenu ee pani repu cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "telugu_obligation" },
  { id: "pos-47", text: "Repu assignment submit cheyyali 2 PM ki", expectedIntent: "task_or_commitment", language: "te", category: "telugu_obligation" },
  { id: "pos-48", text: "Subah 6 baje levali", expectedIntent: "task_or_commitment", language: "te", category: "telugu_obligation" },
  { id: "pos-49", text: "Class aipoyaka library ki vellali", expectedIntent: "task_or_commitment", language: "te", category: "anchor_after_class" },
  { id: "pos-50", text: "Project report submit chestam", expectedIntent: "task_or_commitment", language: "te", category: "telugu_obligation" },
  { id: "pos-51", text: "Repu morning lab ki attend avali", expectedIntent: "task_or_commitment", language: "te", category: "anchor_morning" },
  { id: "pos-52", text: "Intiki vellaka chaduvukovali", expectedIntent: "task_or_commitment", language: "te", category: "anchor_reaching_home" },
  { id: "pos-53", text: "First class mundu fees pay cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "anchor_before_class" },
  { id: "pos-54", text: "College nunchi bayalderetappudu bus pass teesukovali", expectedIntent: "task_or_commitment", language: "te", category: "anchor_leaving_college" },
  { id: "pos-55", text: "Nenu eeroju night work finish cheyyali", expectedIntent: "task_or_commitment", language: "te", category: "telugu_obligation" },
  { id: "pos-56", text: "Repu submit cheyyali compulsory", expectedIntent: "task_or_commitment", language: "mixed", category: "telugu_obligation" },
  { id: "pos-57", text: "Assignment complete cheyyali by evening", expectedIntent: "task_or_commitment", language: "mixed", category: "anchor_evening" },
  { id: "pos-58", text: "Sir ki email send cheyyali", expectedIntent: "task_or_commitment", language: "mixed", category: "telugu_obligation" },
  { id: "pos-59", text: "Records verify cheyinchukovali", expectedIntent: "task_or_commitment", language: "mixed", category: "telugu_obligation" },
  { id: "pos-60", text: "Fee receipt submit cheyyali college lo", expectedIntent: "task_or_commitment", language: "mixed", category: "telugu_obligation" },
];

export function runBenchmark() {
  console.log("==================================================================");
  console.log("RUNNING GATE G2: EVAL BENCHMARK (>=140 CASES, >=80 NEGATIVES)");
  console.log("==================================================================\n");

  // Load any real user messages from tests/eval_real_messages.json
  const realPath = path.resolve("tests/eval_real_messages.json");
  let realCases: TestCase[] = [];
  try {
    if (fs.existsSync(realPath)) {
      const content = fs.readFileSync(realPath, "utf-8").trim();
      if (content) {
        realCases = JSON.parse(content);
      }
    }
  } catch {}

  const fullDataset = [...EVAL_DATASET, ...realCases];

  // Compute dataset SHA-256 hash
  const jsonStr = JSON.stringify(fullDataset);
  const hash = crypto.createHash("sha256").update(jsonStr).digest("hex");

  console.log(`Dataset size: ${fullDataset.length} cases`);
  console.log(`Negatives:    ${fullDataset.filter((c) => c.expectedIntent === "negative").length}`);
  console.log(`Positives:    ${fullDataset.filter((c) => c.expectedIntent === "task_or_commitment").length}`);
  console.log(`Real user msg: ${realCases.length}`);
  console.log(`Dataset SHA256: ${hash}\n`);

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;

  const falsePositives: Array<{ id: string; text: string; evidence: string }> = [];
  const falseNegatives: Array<{ id: string; text: string }> = [];

  for (const tc of fullDataset) {
    const { detected, evidence } = detectObligation(tc.text);
    const predicted = detected ? "task_or_commitment" : "negative";

    if (tc.expectedIntent === "task_or_commitment" && predicted === "task_or_commitment") {
      tp++;
    } else if (tc.expectedIntent === "negative" && predicted === "negative") {
      tn++;
    } else if (tc.expectedIntent === "negative" && predicted === "task_or_commitment") {
      fp++;
      falsePositives.push({ id: tc.id, text: tc.text, evidence });
    } else if (tc.expectedIntent === "task_or_commitment" && predicted === "negative") {
      fn++;
      falseNegatives.push({ id: tc.id, text: tc.text });
    }
  }

  const total = fullDataset.length;
  const precision = tp + fp > 0 ? (tp / (tp + fp)) * 100 : 0;
  const recall = tp + fn > 0 ? (tp / (tp + fn)) * 100 : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = ((tp + tn) / total) * 100;
  const fpRate = ((fp / (tn + fp)) * 100);

  console.log("------------------------------------------------------------------");
  console.log("CONFUSION MATRIX:");
  console.log("------------------------------------------------------------------");
  console.log(`  True Positives  (TP): ${tp}`);
  console.log(`  True Negatives  (TN): ${tn}`);
  console.log(`  False Positives (FP): ${fp}`);
  console.log(`  False Negatives (FN): ${fn}`);
  console.log("------------------------------------------------------------------");
  console.log(`  Accuracy:  ${accuracy.toFixed(1)}%`);
  console.log(`  Precision: ${precision.toFixed(1)}%  (Threshold >= 90%)`);
  console.log(`  Recall:    ${recall.toFixed(1)}%  (Threshold >= 90%)`);
  console.log(`  F1-Score:  ${f1.toFixed(1)}%`);
  console.log(`  FP Rate:   ${fpRate.toFixed(2)}% (Threshold <= 4.0%)`);
  console.log("------------------------------------------------------------------\n");

  if (falsePositives.length > 0) {
    console.log("FALSE POSITIVES:");
    for (const f of falsePositives) {
      console.log(`  [${f.id}] "${f.text}" (matched: "${f.evidence}")`);
    }
    console.log();
  }

  if (falseNegatives.length > 0) {
    console.log("FALSE NEGATIVES:");
    for (const f of falseNegatives) {
      console.log(`  [${f.id}] "${f.text}"`);
    }
    console.log();
  }

  const passed =
    fullDataset.length >= 140 &&
    fullDataset.filter((c) => c.expectedIntent === "negative").length >= 80 &&
    fpRate <= 4.0 &&
    precision >= 90.0 &&
    recall >= 90.0;

  if (passed) {
    console.log("GATE G2 STATUS: PASS\n");
  } else {
    console.error("GATE G2 STATUS: FAIL\n");
    process.exit(1);
  }
}

runBenchmark();
