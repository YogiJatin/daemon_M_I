/**
 * worker/aiContextBuilder.ts
 *
 * Dedicated Canonical XML Context Builder for Personal AI OS.
 *
 * Responsibilities:
 * - Assemble structured XML context.
 * - Deduplicate records across entities.
 * - Enforce deterministic ordering.
 * - Output canonical XML format:
 *   <system_rules>...</system_rules>
 *   <context>
 *     <timetable>...</timetable>
 *     <tasks>...</tasks>
 *     <materials>...</materials>
 *     <history>...</history>
 *   </context>
 *   <owner_request>...</owner_request>
 *   <output_contract>...</output_contract>
 * - Integrate with TokenBudgetManager.
 */

import { ContextEntity, TokenBudgetManager } from "./aiTokenBudgetManager";

export const CURRENT_CONTEXT_VERSION = "2.0.0";

export function escapeXml(unsafe: any): string {
  if (unsafe === undefined || unsafe === null) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class AIContextBuilder {
  private entities: ContextEntity[] = [];
  private seenIds = new Set<string>();
  private systemRulesText: string = "";
  private ownerRequestText: string = "";
  private outputContractText: string = "";

  public readonly contextVersion: string = CURRENT_CONTEXT_VERSION;

  public setSystemRules(rules: string): this {
    this.systemRulesText = rules.trim();
    return this;
  }

  public setOwnerRequest(request: string): this {
    this.ownerRequestText = request.trim();
    return this;
  }

  public setOutputContract(contract: string): this {
    this.outputContractText = contract.trim();
    return this;
  }

  /**
   * Adds an entity with deduplication and priority marking.
   */
  public addEntity(
    id: string,
    type: "task" | "class" | "material" | "history" | "attachment" | "knowledge" | "memory" | "other",
    payload: any,
    priority: "mandatory" | "high" | "normal" | "low" = "normal"
  ): this {
    const key = `${type}:${id}`;
    if (this.seenIds.has(key)) {
      return this; // Deduplicate
    }
    this.seenIds.add(key);

    const xml = this.renderEntityXml(id, type, payload);
    this.entities.push({
      id,
      type,
      priority,
      payload,
      xmlRepresentation: xml,
    });
    return this;
  }

  /**
   * Returns list of all indexed entity IDs in context.
   */
  public getIndexedRecordIds(): Set<string> {
    return new Set(this.entities.map((e) => e.id));
  }

  /**
   * Renders a single entity into canonical XML format.
   */
  private renderEntityXml(id: string, type: string, payload: any): string {
    const safeId = escapeXml(id);
    switch (type) {
      case "task":
        return `    <task id="${safeId}" priority="${escapeXml(payload.priority || "normal")}" deadline="${escapeXml(payload.deadline_local_date || "")} ${escapeXml(payload.deadline_time_local || "")}">\n      <title>${escapeXml(payload.title)}</title>\n      <description>${escapeXml(payload.description || "")}</description>\n    </task>`;
      case "class":
        return `    <class id="${safeId}" date="${escapeXml(payload.occurrence_date || payload.date)}" time="${escapeXml(payload.start_time || "")}-${escapeXml(payload.end_time || "")}" room="${escapeXml(payload.room || "")}">\n      <subject>${escapeXml(payload.subject_name || payload.name)}</subject>\n    </class>`;
      case "material":
        return `    <material id="${safeId}" title="${escapeXml(payload.title || "")}" required="${escapeXml(payload.required ? "true" : "false")}"/>`;
      case "history":
        return `    <history_event id="${safeId}" event="${escapeXml(payload.event_type || "")}">\n      <details>${escapeXml(JSON.stringify(payload))}</details>\n    </history_event>`;
      case "attachment":
        return `    <attachment id="${safeId}" filename="${escapeXml(payload.filename || "")}" mime="${escapeXml(payload.mime_type || "")}">\n      <content>${escapeXml(payload.extracted_text || payload.content || "")}</content>\n    </attachment>`;
      case "knowledge":
      case "memory":
        return `    <memory id="${safeId}" type="${escapeXml(payload.type || "note")}">\n      <title>${escapeXml(payload.title || "")}</title>\n      <summary>${escapeXml(payload.summary || payload.excerpt || "")}</summary>\n    </memory>`;
      default:
        return `    <entity id="${safeId}" type="${escapeXml(type)}">\n      <content>${escapeXml(JSON.stringify(payload))}</content>\n    </entity>`;
    }
  }

  /**
   * Builds canonical segmented XML with budget enforcement.
   */
  public build(maxTokens: number = 2500): { xml: string; tokensEstimated: number; trimmedCount: number } {
    const budgetRes = TokenBudgetManager.enforceBudget(this.entities, maxTokens);

    // Group entities deterministically by type
    const byType: Record<string, string[]> = {
      timetable: [],
      tasks: [],
      materials: [],
      memory: [],
      attachments: [],
      history: [],
      other: [],
    };

    for (const ent of budgetRes.entities) {
      const typeKey = ent.type === "class" ? "timetable" : ent.type === "task" ? "tasks" : ent.type === "material" ? "materials" : (ent.type === "knowledge" || ent.type === "memory") ? "memory" : ent.type === "attachment" ? "attachments" : ent.type === "history" ? "history" : "other";
      if (ent.xmlRepresentation) {
        byType[typeKey].push(ent.xmlRepresentation);
      }
    }

    const sections: string[] = [];

    // 1. System Rules
    if (this.systemRulesText) {
      sections.push(`<system_rules>\n${this.systemRulesText}\n</system_rules>`);
    }

    // 2. Structured Canonical Context
    const contextLines: string[] = ["<context>"];
    if (byType.timetable.length > 0) {
      contextLines.push(`  <timetable>\n${byType.timetable.sort().join("\n")}\n  </timetable>`);
    }
    if (byType.tasks.length > 0) {
      contextLines.push(`  <tasks>\n${byType.tasks.sort().join("\n")}\n  </tasks>`);
    }
    if (byType.memory.length > 0) {
      contextLines.push(`  <memory>\n${byType.memory.sort().join("\n")}\n  </memory>`);
    }
    if (byType.materials.length > 0) {
      contextLines.push(`  <materials>\n${byType.materials.sort().join("\n")}\n  </materials>`);
    }
    if (byType.attachments.length > 0) {
      contextLines.push(`  <attachments>\n${byType.attachments.sort().join("\n")}\n  </attachments>`);
    }
    if (byType.history.length > 0) {
      contextLines.push(`  <history>\n${byType.history.sort().join("\n")}\n  </history>`);
    }
    if (byType.other.length > 0) {
      contextLines.push(`  <other>\n${byType.other.sort().join("\n")}\n  </other>`);
    }
    contextLines.push("</context>");
    sections.push(contextLines.join("\n"));

    // 3. Owner Request (Quarantined)
    if (this.ownerRequestText) {
      sections.push(`<owner_request>\n${escapeXml(this.ownerRequestText)}\n</owner_request>`);
    }

    // 4. Output Contract
    if (this.outputContractText) {
      sections.push(`<output_contract>\n${this.outputContractText}\n</output_contract>`);
    }

    const finalXml = sections.join("\n\n");
    return {
      xml: finalXml,
      tokensEstimated: TokenBudgetManager.estimateTokens(finalXml),
      trimmedCount: budgetRes.trimmedCount,
    };
  }
}
