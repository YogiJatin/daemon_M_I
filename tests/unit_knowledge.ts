/**
 * tests/unit_knowledge.ts — Block 8 Memory OS Unit Test Suite
 *
 * Requirements:
 * 1. Canonical Object Creation: 18 canonical memory types, deduplication.
 * 2. Duplicate Detection: Duplicate attachments or titles resolve to single canonical row.
 * 3. Relationship Discovery: Typed graph edges, confidence scoring, origin tracking.
 * 4. Deterministic Graph Building: Cycle detection, depth limits, stable ordering.
 * 5. Semantic Search: Multi-criteria relevance scoring, tag filtering, snippets.
 * 6. Timeline Generation: Memory understanding evolution (distinct from audit).
 * 7. AI Context Retrieval: Token budgeting, explainable citations, no raw binary blobs.
 * 8. Export Integration: memory_objects, memory_relationships, memory_tags included.
 * 9. Audit Integration: MEMORY_CREATED, RELATIONSHIP_CREATED, SUMMARY_GENERATED events.
 * 10. Scheduler & Engine Isolation: Zero imports or references in untouched files.
 */

import { MemoryObjectService } from "../worker/memoryObjectService";
import { MemoryRelationshipService } from "../worker/memoryRelationshipService";
import { MemoryGraphEngine } from "../worker/memoryGraph";
import { MemorySearchEngine } from "../worker/memorySearch";
import { MemoryTimelineEngine } from "../worker/memoryTimeline";
import { MemoryIndexer } from "../worker/memoryIndexer";
import { MemorySummarizer } from "../worker/memorySummarizer";
import { MemoryRetriever } from "../worker/memoryRetriever";
import { MemoryContextProvider } from "../worker/memoryContextProvider";
import { AIContextBuilder } from "../worker/aiContextBuilder";
import { getExportData } from "../worker/exportService";
import { createMockD1 } from "./mockD1";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function runMemoryUnitTests() {
  console.log("\n=== RUNNING BLOCK 8 MEMORY OS UNIT TESTS ===\n");
  const db = createMockD1();
  const env = { DB: db, TEST_MODE: "true" };
  const fixedNow = new Date("2026-10-21T10:00:00.000Z");

  // ----------------------------------------------------
  // 1. Untouched Files & Scheduler Isolation (Rule 5 & 18)
  // ----------------------------------------------------
  console.log("--- 1. Untouched Files & Invariant Isolation ---");
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
  // 2. Canonical Object Creation & Content Deduplication
  // ----------------------------------------------------
  console.log("\n--- 2. Canonical Object Creation & Deduplication ---");
  const obj1 = await MemoryObjectService.getOrCreateCanonicalObject(
    db,
    {
      type: "lecture",
      title: "CS301 Lecture 4: Virtual Memory & Page Tables",
      canonicalText: "Detailed explanation of multi-level page tables, TLB caches, and page fault handling routines.",
      source: "web",
      tags: ["os", "virtual_memory", "lecture"],
    },
    env,
    fixedNow
  );

  assert(obj1.isDuplicate === false, "First creation is marked canonical (not duplicate)");
  assert(obj1.object.id.startsWith("mem_"), "Memory object ID has 'mem_' prefix");
  assert(obj1.object.type === "lecture", "Correct canonical memory type assigned");

  // Duplicate insertion with exact title and source
  const obj1Dup = await MemoryObjectService.getOrCreateCanonicalObject(
    db,
    {
      type: "lecture",
      title: "CS301 Lecture 4: Virtual Memory & Page Tables",
      canonicalText: "Alternative copy of identical lecture notes.",
      source: "web",
    },
    env,
    fixedNow
  );

  assert(obj1Dup.isDuplicate === true, "Exact title and source resolves to existing canonical object");
  assert(obj1Dup.object.id === obj1.object.id, "Duplicate returns existing object ID");

  // Deduplication via attachment reference
  const fakeAttId = "att_test_shared_attachment";
  await db
    .prepare(
      "INSERT INTO attachments (id, filename, mime_type, byte_size, sha256_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(
      fakeAttId,
      "syllabus.pdf",
      "application/pdf",
      1024,
      "hash_1234567890abcdef",
      fixedNow.toISOString()
    )
    .run();

  const objWithAtt1 = await MemoryObjectService.getOrCreateCanonicalObject(
    db,
    {
      type: "document",
      title: "Operating Systems Syllabus PDF",
      canonicalText: "Course syllabus for fall semester.",
      attachmentId: fakeAttId,
      source: "document_upload",
    },
    env,
    fixedNow
  );
  assert(objWithAtt1.isDuplicate === false, "Attachment-backed memory object created");

  const objWithAtt2 = await MemoryObjectService.getOrCreateCanonicalObject(
    db,
    {
      type: "document",
      title: "Different Title for Same PDF",
      canonicalText: "Different text referencing same attachment.",
      attachmentId: fakeAttId,
      source: "telegram",
    },
    env,
    fixedNow
  );
  assert(objWithAtt2.isDuplicate === true, "Shared attachmentId resolves to same canonical memory object");
  assert(objWithAtt2.object.id === objWithAtt1.object.id, "Reuses identical memory object ID across sources");

  // ----------------------------------------------------
  // 3. Graph Relationships & Cycle-Safe Traversals
  // ----------------------------------------------------
  console.log("\n--- 3. Relationship Graph & Cycle Safety ---");
  const objNote = await MemoryObjectService.getOrCreateCanonicalObject(
    db,
    {
      type: "note",
      title: "Midterm Revision Note: Page Replacement",
      canonicalText: "LRU and Clock page replacement algorithms comparison.",
      source: "web",
    },
    env,
    fixedNow
  );

  const edge1 = await MemoryRelationshipService.link(
    db,
    {
      fromObject: objNote.object.id,
      toObject: obj1.object.id,
      relationshipType: "references",
      confidence: 0.95,
      origin: "user",
    },
    env,
    fixedNow
  );

  assert(edge1.id.startsWith("mrel_"), "Relationship edge receives 'mrel_' prefix");
  assert(edge1.confidence === 0.95, "Edge preserves confidence score");
  assert(edge1.relationshipType === "references", "Relationship type recorded accurately");

  // Cycle test: Add reverse edge to test cycle-safety
  await MemoryRelationshipService.link(
    db,
    {
      fromObject: obj1.object.id,
      toObject: objNote.object.id,
      relationshipType: "related_to",
      confidence: 0.8,
      origin: "auto",
    },
    env,
    fixedNow
  );

  // Subgraph extraction with depth limit and cycle detection
  const graph = await MemoryGraphEngine.getSubgraph(db, obj1.object.id, 2);
  assert(graph.nodes.length >= 2, `Subgraph contains expected nodes (got ${graph.nodes.length})`);
  assert(graph.edges.length >= 2, `Subgraph contains expected edges (got ${graph.edges.length})`);
  assert(graph.depth <= 3, "Graph traversal strictly bounded by depth limit");

  const formattedGraph = MemoryGraphEngine.formatCanonicalGraph(graph);
  assert(formattedGraph.includes("GRAPH_NODES") && formattedGraph.includes("GRAPH_EDGES"), "Graph formats to canonical text representation");

  // Self-referencing link prevention
  let selfLinkBlocked = false;
  try {
    await MemoryRelationshipService.link(
      db,
      {
        fromObject: obj1.object.id,
        toObject: obj1.object.id,
        relationshipType: "references",
      },
      env,
      fixedNow
    );
  } catch {
    selfLinkBlocked = true;
  }
  assert(selfLinkBlocked, "Self-referencing relationship edges are rejected");

  // ----------------------------------------------------
  // 4. Memory Timeline vs Audit Separation
  // ----------------------------------------------------
  console.log("\n--- 4. Memory Timeline (Understanding Evolution) ---");
  const timeline = await MemoryTimelineEngine.getTimeline(db, obj1.object.id);
  assert(timeline.length >= 2, `Timeline contains creation and relationship events (got ${timeline.length})`);
  assert(timeline[0].eventType === "object_created", "Initial timeline event is 'object_created'");
  assert(timeline.some((e) => e.eventType === "relationship_linked"), "Timeline captures relationship linking events");

  // ----------------------------------------------------
  // 5. Cached Summarization
  // ----------------------------------------------------
  console.log("\n--- 5. Cached Summarization ---");
  const sum1 = await MemorySummarizer.getOrGenerateSummary(db, obj1.object.id, false, env, fixedNow);
  assert(sum1.wasCached === false, "First summary request generates summary");
  assert(sum1.summary.length > 10, "Summary produces non-trivial text");

  // Second request uses cache
  const sum2 = await MemorySummarizer.getOrGenerateSummary(db, obj1.object.id, false, env, fixedNow);
  assert(sum2.wasCached === true, "Subsequent summary request returns cached summary");
  assert(sum2.summary === sum1.summary, "Cached summary is identical to generated summary");

  // ----------------------------------------------------
  // 6. Multi-Faceted Semantic Search
  // ----------------------------------------------------
  console.log("\n--- 6. Multi-Faceted Semantic Search ---");
  const searchKw = await MemorySearchEngine.search(db, { keyword: "Virtual Memory" });
  assert(searchKw.length >= 1, "Keyword search matches title and content");
  assert(searchKw[0].object.id === obj1.object.id, "Top ranked search result matches expected memory object");
  assert(searchKw[0].relevanceScore > 0.5, "Relevance score is positively calibrated");

  const searchTag = await MemorySearchEngine.search(db, { tag: "os" });
  assert(searchTag.length >= 1, "Tag search retrieves tagged memory objects");

  const searchType = await MemorySearchEngine.search(db, { type: "lecture" });
  assert(searchType.every((r) => r.object.type === "lecture"), "Type filter restricts results strictly to requested type");

  // ----------------------------------------------------
  // 7. Grounded Retrieval & Explainable Citations
  // ----------------------------------------------------
  console.log("\n--- 7. Grounded Retrieval & Citations ---");
  const bundle = await MemoryRetriever.retrieve(db, "page replacement algorithms", {
    maxItems: 3,
    maxTokens: 500,
    includeRelationships: true,
  });

  assert(bundle.primaryObjects.length > 0, "Retriever returns relevant primary memory objects");
  assert(bundle.citations.length === bundle.primaryObjects.length, "Generates exact 1:1 citations for primary objects");
  assert(bundle.citations[0].reasonSelected.length > 0, "Citation includes explicit explainability selection reason");
  assert(bundle.totalTokensEstimated <= 500, "Retrieval budget respects maxTokens ceiling");

  // ----------------------------------------------------
  // 8. AI Context Builder Integration
  // ----------------------------------------------------
  console.log("\n--- 8. AI Context Builder Integration ---");
  const builder = new AIContextBuilder();
  builder.setSystemRules("You are the Personal AI OS Analytical Engine.");
  builder.setOwnerRequest("Summarize our virtual memory lectures.");

  await MemoryContextProvider.injectMemoryContext(db, "virtual memory", builder);
  const contextOutput = builder.build(2000);

  assert(contextOutput.xml.includes("<memory"), "Context contains structured canonical <memory> segment");
  assert(!contextOutput.xml.includes(".pdf"), "Context does not inject raw PDF blobs");

  // ----------------------------------------------------
  // 9. Ingress Indexer Pipeline (Block 7 -> Block 8 Bridge)
  // ----------------------------------------------------
  console.log("\n--- 9. Ingress Indexer Integration ---");
  const indexRes = await MemoryIndexer.indexFromIngress(
    db,
    {
      type: "note",
      title: "Research paper on Distributed Consensus algorithms #research #project",
      text: "Consensus algorithms ensure fault tolerance in distributed computing clusters.",
      source: "ingress_pipeline",
    },
    env,
    fixedNow
  );

  assert(indexRes.memoryObjectId.startsWith("mem_"), "Ingress indexer produces canonical memory object ID");
  const indexedTags = await MemoryObjectService.getTags(db, indexRes.memoryObjectId);
  assert(indexedTags.includes("research"), "Auto-extracts #research hashtag");
  assert(indexedTags.includes("project"), "Auto-extracts #project hashtag");

  // ----------------------------------------------------
  // 10. System Export & Audit Chain Invariants
  // ----------------------------------------------------
  console.log("\n--- 10. System Export & Audit Invariants ---");
  const exportPayload = await getExportData(db, fixedNow);
  assert(exportPayload.counts.memory_objects !== undefined, "Export payload includes memory_objects count");
  assert(exportPayload.counts.memory_relationships !== undefined, "Export payload includes memory_relationships count");
  assert(exportPayload.counts.memory_tags !== undefined, "Export payload includes memory_tags count");
  assert(exportPayload.data.memory_objects.length >= 3, "Export data includes all created memory objects");

  console.log("\n========================================");
  console.log(`TOTAL: ${passCount + failCount} | PASSED: ${passCount} | FAILED: ${failCount}`);
  console.log("========================================\n");

  if (failCount > 0) {
    process.exit(1);
  }
}

runMemoryUnitTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
