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
 * - Immutability: Definitions are frozen upon registration; registry locks after initialization.
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
  private static capabilities = new Map<string, Readonly<AICapabilityDefinition>>();
  private static locked: boolean = false;

  public static register<TInput, TOutput>(definition: AICapabilityDefinition<TInput, TOutput>): void {
    if (this.locked) {
      throw new Error(`Capability Registry is locked and immutable. Cannot register '${definition?.id}' after initialization.`);
    }
    if (!definition.id || typeof definition.id !== "string") {
      throw new Error("Capability definition must have a valid non-empty 'id'");
    }
    const key = definition.id.toLowerCase();
    if (this.capabilities.has(key)) {
      throw new Error(`Capability '${definition.id}' is already registered and cannot be overwritten.`);
    }
    this.capabilities.set(key, Object.freeze({ ...definition }));
  }

  public static freeze(): void {
    this.locked = true;
  }

  public static isFrozen(): boolean {
    return this.locked;
  }

  public static get(id: string): Readonly<AICapabilityDefinition> | null {
    if (!id) return null;
    return this.capabilities.get(id.toLowerCase()) || null;
  }

  public static list(): Readonly<AICapabilityDefinition>[] {
    return Array.from(this.capabilities.values());
  }

  public static clear(): void {
    this.locked = false;
    this.capabilities.clear();
  }
}
