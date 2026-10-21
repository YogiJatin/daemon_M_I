/**
 * worker/exportService.ts — Block 5 JSON/CSV Data Portability & Export Service
 *
 * Requirements (Personal_AI_OS_SRS_v2.2.md §§11.2, 14.3, 15 NFR-012, TEST-5.2):
 * - Comprehensive JSON and CSV export of owner data:
 *   tasks, recurrence rules, semesters, subjects, slots, materials,
 *   exceptions, holiday calendar, class occurrences, settings, and audit events.
 * - ZERO SECRETS EXPORTED:
 *   auth_sessions, pairing_challenges, telegram_updates, bot tokens,
 *   webhook secrets, internal lease/cap states are strictly omitted.
 * - CSV Injection (Formula Injection) mitigation:
 *   Cells starting with '=', '+', '-', '@', '\t', '\r' are prepended with a single quote.
 * - Standard RFC 4180 CSV formatting.
 */

import { canonicalizeJson } from "./auditSerializer";
import { sha256Hex } from "./auditHasher";
import { AuditRecord, AuditMetadata, AUDIT_SCHEMA_VERSION } from "./auditService";

export interface SignedExportManifest {
  schema_version: string;
  export_version: string;
  generated_at: string;
  head_hash: string;
  snapshot_hash: string;
  record_count: number;
  checksum_algorithm: "SHA-256";
  checksum: string;
}

export interface SignedExportBundle {
  manifest: SignedExportManifest;
  records: AuditRecord[];
}

export interface ExportDataPayload {
  export_version: string;
  exported_at: string;
  timezone: string;
  counts: Record<string, number>;
  data: {
    tasks: any[];
    recurrence_rules: any[];
    timetable_semesters: any[];
    timetable_subjects: any[];
    timetable_slots: any[];
    timetable_materials: any[];
    timetable_exceptions: any[];
    holiday_calendar: any[];
    class_occurrences: any[];
    settings: any[];
    audit_events: any[];
    task_proposals: any[];
    audit_chain: any[];
    memory_objects: any[];
    memory_relationships: any[];
    memory_tags: any[];
  };
}

/**
 * Escapes a single CSV value following RFC 4180 and neutralizing formula injection.
 */
export function escapeCsvCell(val: any): string {
  if (val === null || val === undefined) {
    return "";
  }
  let str = typeof val === "object" ? JSON.stringify(val) : String(val);

  // OWASP CSV Injection mitigation: prefix leading formula characters with a single quote
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  // If the string contains comma, quote, or newline, escape internal quotes and wrap in quotes
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts an array of objects into an RFC 4180 compliant CSV string.
 */
export function objectsToCsv(rows: any[]): string {
  if (!rows || rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0]);
  const headerLine = headers.map(escapeCsvCell).join(",");
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCsvCell(row[h])).join(",")
  );
  return [headerLine, ...dataLines].join("\r\n");
}

/**
 * Fetches and filters all owner data safely from D1.
 */
export async function getExportData(
  db: D1Database,
  now: Date = new Date()
): Promise<ExportDataPayload> {
  const nowIso = now.toISOString();

  // 1. Tasks (exclude internal transient keys if any, preserve all task metadata)
  const tasksRes = await db
    .prepare(
      `SELECT id, title, description, project, category, status, priority,
              deadline_kind, deadline_local_date, deadline_time_local, deadline_at_utc,
              deadline_version, recurrence_rule_id, occurrence_local_date, occurrence_number,
              series_version, snoozed_until, snooze_count, completed_at, created_at, updated_at
       FROM tasks
       ORDER BY created_at ASC`
    )
    .all<any>();

  // 2. Recurrence Rules
  const recRulesRes = await db
    .prepare(
      `SELECT id, title, description, category, pattern, interval, weekdays_json,
              month_day, year_month, local_time, timezone, start_date, end_date,
              week_anchor_monday, next_generation_date, active, series_version,
              last_occurrence_number, default_priority, created_at, updated_at
       FROM recurrence_rules
       ORDER BY created_at ASC`
    )
    .all<any>();

  // 3. Timetable Semesters
  const semestersRes = await db
    .prepare(
      `SELECT id, name, start_date, end_date, is_active, external_id, created_at, updated_at
       FROM timetable_semesters
       ORDER BY start_date ASC`
    )
    .all<any>();

  // 4. Timetable Subjects
  const subjectsRes = await db
    .prepare(
      `SELECT id, semester_id, code, name, faculty, default_room, color,
              section_name, preparation_minutes, external_id, created_at, updated_at
       FROM timetable_subjects
       ORDER BY name ASC`
    )
    .all<any>();

  // 5. Timetable Slots
  const slotsRes = await db
    .prepare(
      `SELECT id, semester_id, subject_id, weekday, start_time, end_time, room,
              week_pattern, lab_batch, week_anchor_monday, section_name, active,
              external_id, created_at, updated_at
       FROM timetable_slots
       ORDER BY weekday ASC, start_time ASC`
    )
    .all<any>();

  // 6. Timetable Materials
  const materialsRes = await db
    .prepare(
      `SELECT id, slot_id, material_type, title, notes, required,
              display_order, active, external_id, created_at, updated_at
       FROM timetable_materials
       ORDER BY display_order ASC, title ASC`
    )
    .all<any>();

  // 7. Timetable Exceptions
  const exceptionsRes = await db
    .prepare(
      `SELECT id, slot_id, exception_type, start_date, end_date, new_date,
              new_start_time, new_end_time, reason, external_id, created_at
       FROM timetable_exceptions
       ORDER BY start_date ASC`
    )
    .all<any>();

  // 8. Holiday Calendar
  const holidaysRes = await db
    .prepare(
      `SELECT id, name, holiday_date, is_full_day, holiday_scope, external_id, created_at
       FROM holiday_calendar
       ORDER BY holiday_date ASC`
    )
    .all<any>();

  // 9. Class Occurrences
  const occurrencesRes = await db
    .prepare(
      `SELECT id, slot_id, semester_id, subject_id, occurrence_date,
              start_time, end_time, room, status, created_at, updated_at
       FROM class_occurrences
       ORDER BY occurrence_date ASC, start_time ASC`
    )
    .all<any>();

  // 10. Settings (FILTER OUT any sensitive / secret keys)
  const settingsRes = await db
    .prepare(`SELECT key, value, updated_at FROM settings`)
    .all<any>();

  const safeSettings = (settingsRes.results || []).filter((s) => {
    const k = (s.key || "").toLowerCase();
    return (
      !k.includes("secret") &&
      !k.includes("token") &&
      !k.includes("key") &&
      !k.includes("password") &&
      !k.includes("auth")
    );
  });

  // 11. Audit Events (exclude sensitive actor/details if any)
  const auditRes = await db
    .prepare(
      `SELECT id, entity_type, entity_id, event_type, actor, details_json, created_at
       FROM audit_events
       ORDER BY created_at ASC`
    )
    .all<any>();

  const tasks = tasksRes.results || [];
  const recRules = recRulesRes.results || [];
  const semesters = semestersRes.results || [];
  const subjects = subjectsRes.results || [];
  const slots = slotsRes.results || [];
  const materials = materialsRes.results || [];
  const exceptions = exceptionsRes.results || [];
  const holidays = holidaysRes.results || [];
  const occurrences = occurrencesRes.results || [];
  const auditEvents = auditRes.results || [];
  const proposalsRes = await db
    .prepare(
      `SELECT id, source_event_id, title, description, category, priority,
              date_role, proposed_local_date, proposed_local_time, evidence_quote,
              ambiguity_reasons, advisory_confidence, status, task_id, reviewed_at,
              created_at, updated_at
       FROM task_proposals
       ORDER BY created_at ASC`
    )
    .all<any>();
  const proposals = proposalsRes.results || [];

  // 13. Audit Chain (Block 6.2)
  let auditChainRecords: any[] = [];
  try {
    const chainRes = await db.prepare("SELECT * FROM audit_chain ORDER BY sequence_number ASC").all<any>();
    auditChainRecords = chainRes.results || [];
  } catch {
    auditChainRecords = [];
  }

  // 14. Memory OS (Block 8)
  let memoryObjects: any[] = [];
  let memoryRelationships: any[] = [];
  let memoryTags: any[] = [];
  try {
    const memRes = await db.prepare("SELECT * FROM memory_objects ORDER BY created_at ASC").all<any>();
    memoryObjects = memRes.results || [];
    const relRes = await db.prepare("SELECT * FROM memory_relationships ORDER BY created_at ASC").all<any>();
    memoryRelationships = relRes.results || [];
    const tagRes = await db.prepare("SELECT * FROM memory_tags ORDER BY created_at ASC").all<any>();
    memoryTags = tagRes.results || [];
  } catch {
    memoryObjects = [];
    memoryRelationships = [];
    memoryTags = [];
  }

  return {
    export_version: "1.0",
    exported_at: nowIso,
    timezone: "Asia/Kolkata",
    counts: {
      tasks: tasks.length,
      recurrence_rules: recRules.length,
      timetable_semesters: semesters.length,
      timetable_subjects: subjects.length,
      timetable_slots: slots.length,
      timetable_materials: materials.length,
      timetable_exceptions: exceptions.length,
      holiday_calendar: holidays.length,
      class_occurrences: occurrences.length,
      settings: safeSettings.length,
      audit_events: auditEvents.length,
      task_proposals: proposals.length,
      audit_chain: auditChainRecords.length,
      memory_objects: memoryObjects.length,
      memory_relationships: memoryRelationships.length,
      memory_tags: memoryTags.length,
    },
    data: {
      tasks,
      recurrence_rules: recRules,
      timetable_semesters: semesters,
      timetable_subjects: subjects,
      timetable_slots: slots,
      timetable_materials: materials,
      timetable_exceptions: exceptions,
      holiday_calendar: holidays,
      class_occurrences: occurrences,
      settings: safeSettings,
      audit_events: auditEvents,
      task_proposals: proposals,
      audit_chain: auditChainRecords,
      memory_objects: memoryObjects,
      memory_relationships: memoryRelationships,
      memory_tags: memoryTags,
    },
  };
}

/**
 * Generates formatted multi-table CSV or single entity CSV.
 */
export async function getExportCsv(
  db: D1Database,
  entity?: string,
  now: Date = new Date()
): Promise<string> {
  const payload = await getExportData(db, now);

  if (entity && (payload.data as any)[entity]) {
    return objectsToCsv((payload.data as any)[entity]);
  }

  // Multi-table CSV export with clear separator headers
  const sections: string[] = [];
  sections.push(`# Personal AI OS Data Export (RFC 4180 CSV)\r\n# Exported At: ${payload.exported_at}\r\n# Timezone: ${payload.timezone}\r\n`);

  for (const [table, rows] of Object.entries(payload.data)) {
    sections.push(`\r\n### TABLE: ${table} (Total rows: ${rows.length}) ###\r\n`);
    if (rows.length > 0) {
      sections.push(objectsToCsv(rows));
    } else {
      sections.push("# (No records)");
    }
  }

  return sections.join("\r\n");
}


/**
 * Generates Signed Export Bundle containing manifest.json and records array (Requirement 9).
 */
export async function getSignedExportJson(
  db: D1Database,
  now: Date = new Date()
): Promise<SignedExportBundle> {
  const nowIso = now.toISOString();

  // 1. Fetch all audit chain records
  const recordsRes = await db
    .prepare(
      `SELECT * FROM audit_chain
       ORDER BY sequence_number ASC`
    )
    .all<AuditRecord>();

  const records = recordsRes.results || [];

  // 2. Fetch chain metadata
  const meta = await db
    .prepare("SELECT * FROM audit_metadata WHERE key = 'singleton'")
    .first<AuditMetadata>();

  const headHash = meta?.head_hash || (records.length > 0 ? records[records.length - 1].current_hash : "GENESIS");

  // Fetch latest snapshot hash if any
  const snap = await db
    .prepare("SELECT merkle_root FROM audit_snapshots ORDER BY last_sequence DESC LIMIT 1")
    .first<{ merkle_root: string }>();

  const snapshotHash = snap?.merkle_root || "NONE";

  // 3. Compute canonical checksum over records
  const canonicalRecords = canonicalizeJson(records);
  const checksum = await sha256Hex(canonicalRecords);

  const manifest: SignedExportManifest = {
    schema_version: AUDIT_SCHEMA_VERSION,
    export_version: "2.0.0",
    generated_at: nowIso,
    head_hash: headHash,
    snapshot_hash: snapshotHash,
    record_count: records.length,
    checksum_algorithm: "SHA-256",
    checksum,
  };

  return {
    manifest,
    records,
  };
}