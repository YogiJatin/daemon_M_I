/**
 * tests/run_block8_acceptance.ts — Block 8 Memory OS Live Acceptance Test Battery
 *
 * Requirements:
 * - TEST-8.1: Memory Object Canonical Listing & Pagination (/api/v1/memory)
 * - TEST-8.2: Memory Object Retrieval with Tags & Relationship Count (/api/v1/memory/:id)
 * - TEST-8.3: Content Deduplication & Canonical Object Ingestion (/api/v1/memory POST)
 * - TEST-8.4: Multi-Faceted Semantic & Keyword Search (/api/v1/memory/search)
 * - TEST-8.5: Relationship Graph Edge Creation & Validation (/api/v1/memory/link)
 * - TEST-8.6: Self-Reference Link Rejection (Safety check)
 * - TEST-8.7: Bidirectional Relationship Traversal (/api/v1/memory/:id/relationships)
 * - TEST-8.8: Memory Timeline of Understanding Evolution (/api/v1/memory/:id/timeline)
 * - TEST-8.9: Cached Summarization Lifecycle (/api/v1/memory/:id/summarize)
 * - TEST-8.10: Backward-Compatibility Aliases (/api/v1/knowledge/*)
 * - TEST-8.11: System Portability Export includes Memory OS Tables (/api/v1/export)
 * - TEST-8.12: Strict Scheduler & Recurrence Isolation Invariant (Rule 5 & 18)
 */

import { handleApiRequest } from "../worker/apiRouter";
import { createMockD1 } from "./mockD1";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, name: string, details?: any) {
  if (condition) {
    console.log(`  ✅ PASS: ${name}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${name}`, details ? JSON.stringify(details, null, 2) : "");
    failedCount++;
  }
}

async function request(
  method: string,
  urlPath: string,
  body: any = null,
  env: any,
  now: Date
): Promise<{ status: number; json: any; res: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const init: RequestInit = {
    method,
    headers,
  };
  if (body) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const req = new Request(`https://personal-ai-os.local${urlPath}`, init);
  const session = {
    token_hash: "hash_test_owner",
    label: "Test Session",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86400000).toISOString(),
    last_seen_at: now.toISOString(),
  };

  const res = await handleApiRequest(req, env, session, now);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}

async function runBlock8Acceptance() {
  console.log("\n========================================================");
  console.log("   BLOCK 8 — MEMORY OS ACCEPTANCE TEST BATTERY");
  console.log("========================================================\n");

  const db = createMockD1();
  const env = {
    DB: db,
    TELEGRAM_OWNER_ID: "8364430714",
    TELEGRAM_BOT_TOKEN: "mock_token",
    TEST_MODE: "true",
  };
  const fixedNow = new Date("2026-10-21T10:00:00.000Z");

  // ----------------------------------------------------
  // TEST-8.12: Scheduler & Recurrence Isolation Invariant
  // ----------------------------------------------------
  console.log("--- 1. Scheduler Isolation Invariant (Rule 5 & Rule 18) ---");
  const schedulerCode = fs.readFileSync(path.join(__dirname, "../worker/scheduler.ts"), "utf8");
  const recurrenceCode = fs.readFileSync(path.join(__dirname, "../worker/recurrenceEngine.ts"), "utf8");
  const timetableCode = fs.readFileSync(path.join(__dirname, "../worker/timetableEngine.ts"), "utf8");
  const notificationCode = fs.readFileSync(path.join(__dirname, "../worker/notificationPlanner.ts"), "utf8");
  const capabilityRegistryCode = fs.readFileSync(path.join(__dirname, "../worker/aiCapabilityRegistry.ts"), "utf8");
  const executionPlannerCode = fs.readFileSync(path.join(__dirname, "../worker/aiExecutionPlanner.ts"), "utf8");

  const memoryRegex = /memoryObjectService|memoryRelationship|memoryGraph|memorySearch|memoryIndexer|memoryRetriever/i;
  assert(!memoryRegex.test(schedulerCode), "Rule 5: worker/scheduler.ts has 0 references to Memory OS");
  assert(!memoryRegex.test(recurrenceCode), "Rule 18: worker/recurrenceEngine.ts has 0 references to Memory OS");
  assert(!memoryRegex.test(timetableCode), "Rule 18: worker/timetableEngine.ts has 0 references to Memory OS");
  assert(!memoryRegex.test(notificationCode), "Rule 18: worker/notificationPlanner.ts has 0 references to Memory OS");
  assert(!memoryRegex.test(capabilityRegistryCode), "Rule 18: worker/aiCapabilityRegistry.ts has 0 references to Memory OS");
  assert(!memoryRegex.test(executionPlannerCode), "Rule 18: worker/aiExecutionPlanner.ts has 0 references to Memory OS");

  // ----------------------------------------------------
  // TEST-8.3: Content Deduplication & Canonical Object Ingestion
  // ----------------------------------------------------
  console.log("\n--- 2. Ingestion & Content Deduplication (/api/v1/memory POST) ---");
  const createRes1 = await request(
    "POST",
    "/api/v1/memory",
    {
      type: "lecture",
      title: "Distributed Systems: Consensus & Raft",
      canonicalText: "Detailed explanation of leader election, log replication, and Raft consensus safety guarantees.",
      source: "web",
      tags: ["distributed_systems", "raft", "lecture"],
    },
    env,
    fixedNow
  );
  assert(createRes1.status === 201, "POST /api/v1/memory returns HTTP 201 Created");
  assert(createRes1.json.ok === true, "Response envelope indicates ok: true");
  assert(createRes1.json.data.object.id.startsWith("mem_"), "Object ID assigned with 'mem_' prefix");
  assert(createRes1.json.data.isDuplicate === false, "First insertion is not a duplicate");
  const mem1Id = createRes1.json.data.object.id;

  // Duplicate insertion
  const createRes2 = await request(
    "POST",
    "/api/v1/memory",
    {
      type: "lecture",
      title: "Distributed Systems: Consensus & Raft",
      canonicalText: "Alternative text copy of consensus lecture.",
      source: "web",
    },
    env,
    fixedNow
  );
  assert(createRes2.status === 200, "POST /api/v1/memory duplicate returns HTTP 200");
  assert(createRes2.json.data.isDuplicate === true, "Duplicate flagged correctly");
  assert(createRes2.json.data.object.id === mem1Id, "Duplicate resolves to identical canonical object ID");

  // Insert a second memory object for graph testing
  const createRes3 = await request(
    "POST",
    "/api/v1/memory",
    {
      type: "note",
      title: "Raft Midterm Review Notes",
      canonicalText: "Quick summary of term numbers, commitIndex, and matchIndex for Raft.",
      source: "command_bar",
      tags: ["distributed_systems", "exam_prep"],
    },
    env,
    fixedNow
  );
  const mem2Id = createRes3.json.data.object.id;
  assert(createRes3.status === 201, "Second memory object created successfully");

  // ----------------------------------------------------
  // TEST-8.1: Memory Object Canonical Listing & Pagination
  // ----------------------------------------------------
  console.log("\n--- 3. Canonical Object Listing & Filtering (/api/v1/memory GET) ---");
  const listRes = await request("GET", "/api/v1/memory?limit=10&page=1", null, env, fixedNow);
  assert(listRes.status === 200, "GET /api/v1/memory returns HTTP 200");
  const listObjects = listRes.json.data.objects || listRes.json.data;
  assert(Array.isArray(listObjects), "Response objects is an array");
  assert(listObjects.length >= 2, "Lists all created memory objects");
  assert(listRes.json.data.total >= 2, "Pagination total is accurate");

  // Filter by type
  const filterTypeRes = await request("GET", "/api/v1/memory?type=note", null, env, fixedNow);
  assert(filterTypeRes.status === 200, "GET /api/v1/memory?type=note returns HTTP 200");
  const filterTypeObjects = filterTypeRes.json.data.objects || filterTypeRes.json.data;
  assert(filterTypeObjects.every((o: any) => o.type === "note"), "Type filter restricts results strictly to 'note'");

  // Filter by tag
  const filterTagRes = await request("GET", "/api/v1/memory?tag=exam_prep", null, env, fixedNow);
  assert(filterTagRes.status === 200, "GET /api/v1/memory?tag=exam_prep returns HTTP 200");
  const filterTagObjects = filterTagRes.json.data.objects || filterTagRes.json.data;
  assert(filterTagObjects.length === 1, "Tag filter returns exact matching memory object");
  assert(filterTagObjects[0].id === mem2Id, "Tag filter returned correct object ID");

  // ----------------------------------------------------
  // TEST-8.2: Memory Object Retrieval with Tags & Relationships
  // ----------------------------------------------------
  console.log("\n--- 4. Memory Object Inspection (/api/v1/memory/:id GET) ---");
  const getRes = await request("GET", `/api/v1/memory/${mem1Id}`, null, env, fixedNow);
  assert(getRes.status === 200, "GET /api/v1/memory/:id returns HTTP 200");
  assert(getRes.json.data.id === mem1Id, "Returns correct object ID");
  assert(Array.isArray(getRes.json.data.tags), "Object includes tags array");
  assert(getRes.json.data.tags.includes("raft"), "Tags contain 'raft'");
  assert(typeof getRes.json.data.relationship_count === "number", "Object includes relationship_count");

  // Non-existent ID returns 404
  const notFoundRes = await request("GET", "/api/v1/memory/mem_nonexistent_id", null, env, fixedNow);
  assert(notFoundRes.status === 404, "GET /api/v1/memory/:id non-existent returns HTTP 404");

  // ----------------------------------------------------
  // TEST-8.5 & 8.6: Relationship Graph Linking & Cycle Safety
  // ----------------------------------------------------
  console.log("\n--- 5. Graph Relationships (/api/v1/memory/link POST) ---");
  const linkRes = await request(
    "POST",
    "/api/v1/memory/link",
    {
      from_object: mem2Id,
      to_object: mem1Id,
      relationship_type: "summarizes",
      confidence: 0.95,
      origin: "user",
    },
    env,
    fixedNow
  );
  assert(linkRes.status === 201, "POST /api/v1/memory/link returns HTTP 201 Created");
  assert(linkRes.json.data.id.startsWith("mrel_"), "Relationship edge ID starts with 'mrel_'");
  assert(linkRes.json.data.relationshipType === "summarizes", "Relationship type recorded as 'summarizes'");
  assert(linkRes.json.data.confidence === 0.95, "Confidence preserved at 0.95");

  // Self-link safety rejection (TEST-8.6)
  const selfLinkRes = await request(
    "POST",
    "/api/v1/memory/link",
    {
      from_object: mem1Id,
      to_object: mem1Id,
      relationship_type: "references",
    },
    env,
    fixedNow
  );
  assert(selfLinkRes.status === 400, "Self-referencing relationship rejected with HTTP 400");
  assert(selfLinkRes.json.ok === false, "Self-referencing response indicates ok: false");

  // ----------------------------------------------------
  // TEST-8.7: Bidirectional Relationship Traversal
  // ----------------------------------------------------
  console.log("\n--- 6. Relationship Traversal (/api/v1/memory/:id/relationships) ---");
  const relRes1 = await request("GET", `/api/v1/memory/${mem2Id}/relationships`, null, env, fixedNow);
  assert(relRes1.status === 200, "GET /api/v1/memory/:id/relationships returns HTTP 200");
  assert(relRes1.json.data.relationships.length === 1, "Source object has 1 relationship edge");
  assert(relRes1.json.data.relationships[0].toObject === mem1Id, "Edge connects to expected destination object");

  // Bidirectional reverse check on target
  const relRes2 = await request("GET", `/api/v1/memory/related/${mem1Id}`, null, env, fixedNow);
  assert(relRes2.status === 200, "GET /api/v1/memory/related/:id returns HTTP 200");
  assert(relRes2.json.data.relationships.length === 1, "Target object reflects incoming relationship edge");

  // ----------------------------------------------------
  // TEST-8.8: Memory Timeline (Understanding Evolution)
  // ----------------------------------------------------
  console.log("\n--- 7. Memory Timeline (/api/v1/memory/:id/timeline) ---");
  const timelineRes = await request("GET", `/api/v1/memory/${mem1Id}/timeline`, null, env, fixedNow);
  assert(timelineRes.status === 200, "GET /api/v1/memory/:id/timeline returns HTTP 200");
  const timelineEvents = timelineRes.json.data.timeline || timelineRes.json.data;
  assert(Array.isArray(timelineEvents), "Timeline returns array of events");
  assert(timelineEvents.length >= 2, "Timeline captures creation and relationship linking");
  assert(timelineEvents[0].eventType === "object_created", "Initial timeline event is 'object_created'");

  // ----------------------------------------------------
  // TEST-8.9: Cached Summarization
  // ----------------------------------------------------
  console.log("\n--- 8. Summarization (/api/v1/memory/:id/summarize POST) ---");
  const sumRes1 = await request("POST", `/api/v1/memory/${mem1Id}/summarize`, {}, env, fixedNow);
  assert(sumRes1.status === 200, "POST /api/v1/memory/:id/summarize returns HTTP 200");
  assert(typeof sumRes1.json.data.summary === "string", "Summary string is returned");
  assert(sumRes1.json.data.cached === false, "First summary call indicates cached: false");

  // Second summarization should be served from cache
  const sumRes2 = await request("POST", `/api/v1/memory/${mem1Id}/summarize`, {}, env, fixedNow);
  assert(sumRes2.status === 200, "Second summary call returns HTTP 200");
  assert(sumRes2.json.data.cached === true, "Second summary call indicates cached: true");
  assert(sumRes2.json.data.summary === sumRes1.json.data.summary, "Cached summary text matches initial summary");

  // ----------------------------------------------------
  // TEST-8.4: Multi-Faceted Semantic & Keyword Search
  // ----------------------------------------------------
  console.log("\n--- 9. Semantic & Keyword Search (/api/v1/memory/search GET) ---");
  const searchRes = await request("GET", "/api/v1/memory/search?q=consensus+replication", null, env, fixedNow);
  assert(searchRes.status === 200, "GET /api/v1/memory/search returns HTTP 200");
  const searchResults = searchRes.json.data.results || searchRes.json.data;
  assert(Array.isArray(searchResults), "Search results returned as array");
  assert(searchResults.length > 0, "Finds matching memory objects");
  const topResultId = searchResults[0].object?.id || searchResults[0].id;
  assert(topResultId === mem1Id, "Top result is the consensus lecture");
  assert(searchResults[0].relevanceScore > 0, "Result includes positive relevanceScore");

  // ----------------------------------------------------
  // TEST-8.10: Backward-Compatibility Aliases (/api/v1/knowledge/*)
  // ----------------------------------------------------
  console.log("\n--- 10. Backward-Compatibility Aliases (/api/v1/knowledge/*) ---");
  const kListRes = await request("GET", "/api/v1/knowledge?limit=5", null, env, fixedNow);
  assert(kListRes.status === 200, "GET /api/v1/knowledge returns HTTP 200");
  const kListObjects = kListRes.json.data.objects || kListRes.json.data;
  assert(kListObjects.length === listObjects.length, "Knowledge alias returns identical count as memory");

  const kGetRes = await request("GET", `/api/v1/knowledge/${mem1Id}`, null, env, fixedNow);
  assert(kGetRes.status === 200, "GET /api/v1/knowledge/:id returns HTTP 200");
  assert(kGetRes.json.data.id === mem1Id, "Knowledge alias returns identical memory object");

  const kSearchRes = await request("GET", "/api/v1/knowledge/search?q=Raft", null, env, fixedNow);
  assert(kSearchRes.status === 200, "GET /api/v1/knowledge/search returns HTTP 200");
  const kSearchResults = kSearchRes.json.data.results || kSearchRes.json.data;
  assert(kSearchResults.length > 0, "Knowledge search alias returns search results");

  // ----------------------------------------------------
  // TEST-8.11: System Portability Export includes Memory OS Tables
  // ----------------------------------------------------
  console.log("\n--- 11. System Portability Export (/api/v1/export) ---");
  const exportRes = await request("GET", "/api/v1/export", null, env, fixedNow);
  assert(exportRes.status === 200, "GET /api/v1/export returns HTTP 200");
  assert(typeof exportRes.json.data.counts.memory_objects === "number", "Export counts include memory_objects");
  assert(exportRes.json.data.counts.memory_objects >= 2, "Export counts memory_objects accurately (>= 2)");
  assert(typeof exportRes.json.data.counts.memory_relationships === "number", "Export counts include memory_relationships");
  assert(typeof exportRes.json.data.counts.memory_tags === "number", "Export counts include memory_tags");
  assert(Array.isArray(exportRes.json.data.data.memory_objects), "Export payload contains memory_objects data array");
  assert(Array.isArray(exportRes.json.data.data.memory_relationships), "Export payload contains memory_relationships data array");

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log("\n========================================================");
  console.log(`TOTAL ACCEPTANCE TESTS: ${passedCount + failedCount}`);
  console.log(`PASSED: ${passedCount}`);
  console.log(`FAILED: ${failedCount}`);
  console.log("========================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runBlock8Acceptance().catch((err) => {
  console.error("Acceptance test runner crashed:", err);
  process.exit(1);
});
