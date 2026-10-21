/**
 * worker/aiCapabilityRegistry.ts
 *
 * Dedicated Capability Registry for Personal AI OS.
 *
 * Responsibilities:
 * - Dynamic registry for all analytical and operational capabilities.
 * - Enforces metadata:
 *   - id
 *   - promptId
 *   - promptVersion
 *   - dependencies (declarative data loading)
 *   - supportedPrivacyClasses
 *   - providerAllowList
 *   - maxContextTokens
 *   - maxOutputTokens
 *   - timeoutMs
 *   - validator
 *   - handler
 * - Zero hardcoded switch statements in capability execution.
 */

import { PrivacyClass } from "./aiAdapter";
import { AIContextBuilder } from "./aiContextBuilder";

export type CapabilityDependency = "tasks" | "timetable" | "materials" | "history";

export interface AICapabilityDefinition<TInput = any, TOutput = any> {
  id: string;
  promptId: string;
  promptVersion: string;
  checksum: string;
  dependencies: CapabilityDependency[];
  supportedPrivacyClasses: PrivacyClass[];
  providerAllowList?: string[];
  maxContextTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  systemRules: string;
  outputContract: string;
  contextBuilder: (db: D1Database, input: TInput, builder: AIContextBuilder, now: Date) => Promise<void>;
  validator: (data: any, indexedIds: Set<string>) => { valid: boolean; errors: string[] };
  handler: (db: D1Database, validatedOutput: any, input: TInput, now: Date) => Promise<TOutput>;
}

export class AICapabilityRegistry {
  private static capabilities = new Map<string, AICapabilityDefinition>();

  public static register<TInput, TOutput>(definition: AICapabilityDefinition<TInput, TOutput>): void {
    if (!definition.id || typeof definition.id !== "string") {
      throw new Error("Capability definition must have a valid non-empty 'id'");
    }
    this.capabilities.set(definition.id.toLowerCase(), definition);
  }

  public static get(id: string): AICapabilityDefinition | null {
    if (!id) return null;
    return this.capabilities.get(id.toLowerCase()) || null;
  }

  public static list(): AICapabilityDefinition[] {
    return Array.from(this.capabilities.values());
  }

  public static clear(): void {
    this.capabilities.clear();
  }
}
