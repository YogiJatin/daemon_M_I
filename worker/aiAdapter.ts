/**
 * worker/aiAdapter.ts — Block 6.1 Central AI Capability Adapter & Failover Router
 *
 * Hardened Architecture:
 * - Dynamic dispatch via AICapabilityRegistry.
 * - XML context assembled via AIContextBuilder and TokenBudgetManager.
 * - In-memory LRU prompt cache with canonical XML hashing (AIPromptCache).
 * - Multi-provider failover with Provider Scoring respecting Owner Primacy (AIProviderScoring).
 * - Independent verification with 1 bounded self-repair retry (AIVerifier).
 * - Local Ollama model candidate preparation for Block 9.
 * - Strict Privacy Classification (synthetic_test | low_sensitivity | personal | restricted).
 * - Privacy-scrubbed telemetry logging (no prompt/response bodies).
 * - Zero LLM in scheduler (Rule 5 invariant).
 */

import { AICapabilityRegistry } from "./aiCapabilityRegistry";
import { AIContextBuilder } from "./aiContextBuilder";
import { AIPromptCache } from "./aiPromptCache";
import { AIProviderScoring } from "./aiProviderScoring";
import { AIVerifier } from "./aiVerifier";
import { sendTelegramMessage } from "./telegram";
import { withSystemResults } from "./prompts";

export type PrivacyClass = "synthetic_test" | "low_sensitivity" | "personal" | "restricted";

export interface AIRequest<TInput = any> {
  capability: "task_breakdown" | "weekly_plan" | "prioritize" | "suggest_next" | "propose_task" | "telegram_assistant";
  systemPrompt: string;
  userPrompt: string;
  inputContext: TInput;
  privacyClass: PrivacyClass;
  outputSchema?: Record<string, any>;
  timeoutMs?: number; // default: 6000ms
  /**
   * Output shape for this call. "text" disables provider JSON modes; "json" (default)
   * asks the provider for structured output. This is an explicit request field on
   * purpose: it used to be inferred from the wording of systemPrompt.
   */
  responseFormat?: "json" | "text";
  correlationId?: string;
  simulatedFailure?: "429" | "503" | "timeout" | "malformed_json" | "privacy_blocked"; // for test suites
  temperature?: number; // optional per-request override, clamped to MAX_CHAT_TEMPERATURE
}

export interface AIResponse<TOutput = any> {
  ok: boolean;
  data?: TOutput;
  rawText?: string;
  provider: string;
  model: string;
  durationMs: number;
  fallbackTriggered: boolean;
  error?: {
    code: "rate_limited" | "provider_unavailable" | "privacy_blocked" | "schema_invalid" | "timeout" | "all_providers_failed";
    message: string;
  };
}

export interface ProviderConfig {
  id: string; // 'groq' | 'workers_ai' | 'gemini' | 'ollama' | 'mock' or named profile 'groq_primary', etc.
  providerType: "groq" | "workers_ai" | "gemini" | "ollama" | "mock";
  keySlot?: number;
  apiKey?: string;
  model: string;
  allowedPrivacyClasses: PrivacyClass[];
  timeoutMs: number;
}

// In-memory circuit state across worker requests
interface CircuitState {
  consecutiveFailures: number;
  cooldownUntil: number; // timestamp in ms
  avgLatencyMs: number;
}

const circuitStates = new Map<string, CircuitState>();

export function resetCircuitBreakers(): void {
  circuitStates.clear();
  AIPromptCache.clear();
}

function getCircuitState(providerId: string): CircuitState {
  let state = circuitStates.get(providerId);
  if (!state) {
    state = { consecutiveFailures: 0, cooldownUntil: 0, avgLatencyMs: 200 };
    circuitStates.set(providerId, state);
  }
  return state;
}

/** Hard ceiling for chat/reply generation across every provider. */
/** Chat output stays near-deterministic; anything above this is clamped down. */
export const MAX_CHAT_TEMPERATURE = 0.1;

/**
 * Groq strict mode requires every property to appear in `required` and
 * `additionalProperties: false` at every object level. Capability schemas are written
 * for humans, so normalise them here instead of maintaining two copies.
 *
 * A property marked `nullable: true` becomes type [<type>, "null"], which is how the
 * classifier expresses "may be empty" without dropping the key from the response.
 */
export function toStrictJsonSchema(schema: Record<string, any>): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(schema));
  const walk = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return node;
    }
    if (node.nullable === true) {
      delete node.nullable;
      if (typeof node.type === "string") node.type = [node.type, "null"];
    }
    if (node.type === "array" && node.items) walk(node.items);
    if (node.properties && typeof node.properties === "object") {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties);
      Object.values(node.properties).forEach(walk);
    }
    return node;
  };
  return walk(clone);
}

/**
 * Gemini's responseSchema uses the OpenAPI subset: upper-case type names and no
 * additionalProperties keyword.
 */
export function toGeminiSchema(schema: Record<string, any>): Record<string, any> {
  const clone = JSON.parse(JSON.stringify(schema));
  const walk = (node: any): any => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return node;
    }
    delete node.additionalProperties;
    if (typeof node.type === "string") node.type = node.type.toUpperCase();
    if (node.items) walk(node.items);
    if (node.properties) Object.values(node.properties).forEach(walk);
    return node;
  };
  return walk(clone);
}

/**
 * Clamps a requested temperature to [0, 0.2]. Defaults to 0.1 (deterministic).
 * Used by Groq, Gemini and Workers AI so no provider can run hotter than the cap.
 */
export function resolveTemperature(requested?: number): number {
  const value =
    typeof requested === "number" && Number.isFinite(requested) ? requested : 0.1;
  return Math.max(0, Math.min(value, MAX_CHAT_TEMPERATURE));
}

export class AIAdapter {
  private env: any;
  private db?: D1Database;

  constructor(env: any, db?: D1Database) {
    this.env = env;
    this.db = db;
  }

  /**
   * Resolves the configured provider order respecting owner primacy.
   */
  public getProviderOrder(): string[] {
    const isGeminiParked = this.env?.GEMINI_ENABLED !== "1";
    const defaultOrder = isGeminiParked
      ? "groq_primary,groq_secondary,workers_ai"
      : "groq_primary,groq_secondary,gemini_primary,gemini_secondary,workers_ai";
    const custom = this.env?.AI_PROVIDER_ORDER || defaultOrder;
    let list = custom
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    if (isGeminiParked) {
      list = list.filter((p: string) => !p.includes("gemini"));
    }
    return list;
  }

  /**
   * Helper to resolve the secret API key for a given provider and slot.
   * Slot 1 checks *_KEY_1 then fallback to *_KEY.
   * Slot 2 checks *_KEY_2 then fallback to *_KEY_SECONDARY.
   */
  public resolveApiKey(providerType: "groq" | "gemini", slot: number = 1): string | null {
    if (providerType === "groq") {
      if (slot === 1) {
        return this.env?.GROQ_API_KEY_1 || this.env?.GROQ_API_KEY || null;
      }
      if (slot === 2) {
        return this.env?.GROQ_API_KEY_2 || this.env?.GROQ_API_KEY_SECONDARY || null;
      }
      return this.env?.[`GROQ_API_KEY_${slot}`] || null;
    }
    if (providerType === "gemini") {
      if (slot === 1) {
        return this.env?.GEMINI_API_KEY_1 || this.env?.GEMINI_API_KEY || null;
      }
      if (slot === 2) {
        return this.env?.GEMINI_API_KEY_2 || this.env?.GEMINI_API_KEY_SECONDARY || null;
      }
      return this.env?.[`GEMINI_API_KEY_${slot}`] || null;
    }
    return null;
  }

  public getProviderConfig(providerId: string): ProviderConfig | null {
    const id = providerId.toLowerCase().trim();

    // Groq profiles and slots
    if (id === "groq" || id === "groq_primary" || id === "groq_slot1") {
      return {
        id: "groq_primary",
        providerType: "groq",
        keySlot: 1,
        apiKey: this.resolveApiKey("groq", 1) || undefined,
        model: this.env?.GROQ_MODEL || "openai/gpt-oss-120b",
        allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
        timeoutMs: 6000,
      };
    }
    if (id === "groq_secondary" || id === "groq_slot2") {
      return {
        id: "groq_secondary",
        providerType: "groq",
        keySlot: 2,
        apiKey: this.resolveApiKey("groq", 2) || undefined,
        model: this.env?.GROQ_MODEL_SECONDARY || this.env?.GROQ_MODEL || "openai/gpt-oss-20b",
        allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
        timeoutMs: 6000,
      };
    }

    // Gemini profiles and slots
    if (id === "gemini" || id === "gemini_primary" || id === "gemini_slot1") {
      return {
        id: "gemini_primary",
        providerType: "gemini",
        keySlot: 1,
        apiKey: this.resolveApiKey("gemini", 1) || undefined,
        model: this.env?.GEMINI_MODEL || "gemini-2.0-flash",
        allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
        timeoutMs: 15000,
      };
    }
    if (id === "gemini_secondary" || id === "gemini_slot2") {
      return {
        id: "gemini_secondary",
        providerType: "gemini",
        keySlot: 2,
        apiKey: this.resolveApiKey("gemini", 2) || undefined,
        model: this.env?.GEMINI_MODEL_SECONDARY || this.env?.GEMINI_MODEL || "gemini-1.5-flash",
        allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
        timeoutMs: 15000,
      };
    }

    // Workers AI
    if (id === "workers_ai" || id === "cf_ai") {
      return {
        id: "workers_ai",
        providerType: "workers_ai",
        model: this.env?.WORKERS_AI_MODEL || "@cf/meta/llama-3.2-3b-instruct",
        allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
        timeoutMs: 8000,
      };
    }

    // Ollama Local Desktop
    if (id === "ollama" || id === "ollama_local") {
      return {
        id: "ollama",
        providerType: "ollama",
        model: this.env?.OLLAMA_MODEL || "llama3.2:latest",
        allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal", "restricted"],
        timeoutMs: 10000,
      };
    }

    // Deterministic Mock
    if (id === "mock") {
      return {
        id: "mock",
        providerType: "mock",
        model: "deterministic-mock-v1",
        allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal", "restricted"],
        timeoutMs: 500,
      };
    }

    return null;
  }

  /**
   * Hardened capability execution pipeline using Registry, ContextBuilder,
   * PromptCache, Scoring, and Verifier.
   */
  public async executeCapability<TInput, TOutput>(
    capabilityId: string,
    input: TInput,
    privacyClass: PrivacyClass = "personal",
    simulatedFailure?: any,
    now: Date = new Date()
  ): Promise<AIResponse<TOutput>> {
    const capability = AICapabilityRegistry.get(capabilityId);
    if (!capability) {
      return {
        ok: false,
        provider: "none",
        model: "none",
        durationMs: 0,
        fallbackTriggered: false,
        error: { code: "schema_invalid", message: `Capability '${capabilityId}' is not registered` },
      };
    }

    // 1. Capability Permission Check
    if (!capability.supportedPrivacyClasses.includes(privacyClass)) {
      return {
        ok: false,
        provider: "none",
        model: "none",
        durationMs: 0,
        fallbackTriggered: false,
        error: {
          code: "privacy_blocked",
          message: `Capability '${capabilityId}' does not permit privacy class '${privacyClass}'`,
        },
      };
    }

    // 2. Assemble Context via AIContextBuilder
    const builder = new AIContextBuilder();
    builder.setSystemRules(capability.systemRules).setOutputContract(capability.outputContract);

    if (this.db) {
      await capability.contextBuilder(this.db, input, builder, now);
    }

    const { xml: canonicalXml } = builder.build(capability.maxContextTokens);

    // 3. Prompt Cache Check (Memory-First LRU)
    const normalizedReq = JSON.stringify(input || {});
    const cacheKey = await AIPromptCache.computeKey(
      capability.id,
      capability.promptVersion,
      builder.contextVersion,
      canonicalXml,
      normalizedReq
    );

    if (!simulatedFailure) {
      const cached = AIPromptCache.get<TOutput>(cacheKey, now);
      if (cached) {
        return {
          ok: true,
          data: cached.data,
          rawText: cached.rawText,
          provider: `${cached.provider} (cached)`,
          model: cached.model,
          durationMs: 1,
          fallbackTriggered: false,
        };
      }
    }

    // 4. Provider Scoring & Selection (Owner Primacy)
    let ownerOrder = this.getProviderOrder();
    const isGeminiParked = this.env?.GEMINI_ENABLED !== "1";
    let profileIds = [
      "groq_primary",
      "groq_secondary",
      "workers_ai",
      ...(isGeminiParked ? [] : ["gemini_primary", "gemini_secondary"]),
      "ollama",
      ...(simulatedFailure ? ["mock"] : []),
    ];
    if (this.db) {
      try {
        const setting = await this.db.prepare("SELECT value FROM settings WHERE key = 'disabled_providers'").first<{ value: string }>();
        if (setting?.value) {
          const disabledList = setting.value.toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
          ownerOrder = ownerOrder.filter(p => !disabledList.some(d => p.toLowerCase().includes(d) || d.includes(p.toLowerCase())));
          profileIds = profileIds.filter(p => !disabledList.some(d => p.toLowerCase().includes(d) || d.includes(p.toLowerCase())));
        }
      } catch {}
    }
    const allConfigs = profileIds
      .map((id) => this.getProviderConfig(id))
      .filter((c): c is ProviderConfig => c !== null);

    const scoredCandidates = AIProviderScoring.rankCandidates(allConfigs, ownerOrder, privacyClass, circuitStates, now);

    let fallbackTriggered = false;
    let lastErrorCode: any = "provider_unavailable";
    let lastErrorMessage = "All candidate providers failed or are unavailable";
    // Sibling-slot skip: 503/model-wide errors block same model's other slot this invocation.
    const blockedModels = new Set<string>();

    for (let i = 0; i < scoredCandidates.length; i++) {
      const candidate = scoredCandidates[i];
      const config = candidate.config;

      // Skip ineligible candidates
      if (!candidate.isPrivacyAllowed) {
        lastErrorCode = "privacy_blocked";
        lastErrorMessage = candidate.disqualificationReason || "Privacy tier not permitted";
        continue;
      }

      if (!candidate.isHealthy) {
        fallbackTriggered = true;
        continue;
      }

      // Check capability-specific allowlist if defined
      if (capability.providerAllowList && !capability.providerAllowList.includes(config.id)) {
        continue;
      }

      // Workers AI policy (A7): Workers AI may answer explicit reminders and chat, but never implicit capture
      if (config.providerType === "workers_ai") {
        const uText = ((input as any)?.userText || "").toLowerCase();
        const isImplicit = (input as any)?.intent === "implicit_commitment" ||
          (!/remind|add|buy|call|what|how|schedule|today|tomorrow|weather/i.test(uText) && /\b(i\s+will|i\s+need|i\s+must|i\s+should|i\s+have\s+to|nenu|mujhe)\b/i.test(uText));
        if (isImplicit) {
          continue;
        }
      }

      // Skip sibling slot if same model already gave a 503/model-wide error
      if (blockedModels.has(config.model)) {
        fallbackTriggered = true;
        continue;
      }

      const circuit = getCircuitState(config.id);
      const startTime = Date.now();
      const req: AIRequest = {
        capability: capability.id as any,
        systemPrompt: capability.systemRules,
        userPrompt: canonicalXml,
        inputContext: input,
        privacyClass,
        outputSchema: capability.outputSchema,
        simulatedFailure,
        temperature: typeof (input as any)?.temperature === "number" ? (input as any).temperature : undefined,
      };

      try {
        let result = await this.callProvider<any>(config, req, now);
        let parsedData = result.data;

        // 5. Run AI Verifier
        let verification = capability.validator(parsedData, builder.getIndexedRecordIds());

        // Bounded Self-Repair Retry (1 attempt max)
        if (!verification.valid && (verification as any).repairPrompt) {
          try {
            const repairReq: AIRequest = {
              capability: capability.id as any,
              systemPrompt: capability.systemRules,
              userPrompt: `${canonicalXml}\n\n${(verification as any).repairPrompt}`,
              inputContext: input,
              privacyClass,
              outputSchema: capability.outputSchema,
            };
            const repairRes = await this.callProvider<any>(config, repairReq, now);
            const secondCheck = capability.validator(repairRes.data, builder.getIndexedRecordIds());
            if (secondCheck.valid) {
              parsedData = repairRes.data;
              verification = secondCheck;
            }
          } catch {
            // Repair attempt failed, verification stays invalid
          }
        }

        if (!verification.valid) {
          throw new Error(`AI verification failed: ${verification.errors.join("; ")}`);
        }

        // 6. Execute Handler (Buffers proposals to D1)
        const handledOutput = this.db
          ? await capability.handler(this.db, parsedData, input, now)
          : parsedData;

        const durationMs = Date.now() - startTime;
        circuit.consecutiveFailures = 0;
        circuit.cooldownUntil = 0;
        circuit.avgLatencyMs = Math.round((circuit.avgLatencyMs + durationMs) / 2);

        // Cache successful output
        AIPromptCache.set(
          cacheKey,
          capability.id,
          capability.promptVersion,
          builder.contextVersion,
          handledOutput,
          result.rawText,
          config.id,
          config.model,
          900,
          now
        );

        await this.recordProviderHealth(config.id, config.model, "healthy", 0, durationMs, now);

        return {
          ok: true,
          data: handledOutput,
          rawText: result.rawText,
          provider: config.id,
          model: config.model,
          durationMs,
          fallbackTriggered: fallbackTriggered || i > 0 || candidate.ownerRank > 0,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        fallbackTriggered = true;
        circuit.consecutiveFailures++;

        let failureCode = "500";
        let cooldownMs = 5000;

        if (err.name === "AbortError" || err.message?.includes("timeout")) {
          failureCode = "timeout";
          cooldownMs = 15000;
        } else if (err.status === 429 || err.message?.includes("429")) {
          failureCode = "429";
          const retryAfterMs = err.retryAfterMs || 2000;
          cooldownMs = Math.max(retryAfterMs, 5000);
          const remainingBudget = 6000 - (Date.now() - startTime);
          if (retryAfterMs <= 2000 && remainingBudget > (retryAfterMs + 1000)) {
            try {
              await new Promise((r) => setTimeout(r, retryAfterMs));
              const retryRes = await this.callProvider<any>(config, req, now);
              if (retryRes && retryRes.data) {
                circuit.consecutiveFailures = 0;
                circuit.cooldownUntil = 0;
                return {
                  ok: true,
                  data: retryRes.data,
                  rawText: retryRes.rawText,
                  provider: config.id,
                  model: config.model,
                  durationMs: Date.now() - startTime,
                  fallbackTriggered: fallbackTriggered || i > 0,
                };
              }
            } catch {
              // Retry failed, move to next candidate slot
            }
          }
        } else if (err.status >= 500 || err.message?.includes("503")) {
          failureCode = "503";
          cooldownMs = 30000;
          // Block the other slot sharing this model for the current request
          if (config.model) blockedModels.add(config.model);
        }

        // Permanent errors (bad key / decommissioned model): 24h disable + alert
        if (err.permanent) {
          failureCode = err.status === 401 ? "auth_failed" : "model_decommissioned";
          cooldownMs = 24 * 60 * 60 * 1000;
          circuit.consecutiveFailures = 99;
          this.sendPermanentAlert(config.id, config.model, failureCode).catch(() => {});
        } else if (circuit.consecutiveFailures >= 3) {
          cooldownMs = Math.max(cooldownMs, 300000);
        }

        circuit.cooldownUntil = Date.now() + cooldownMs;
        await this.recordProviderHealth(
          config.id,
          config.model,
          circuit.consecutiveFailures >= 3 ? "cooldown" : "degraded",
          circuit.consecutiveFailures,
          durationMs,
          now,
          failureCode
        );

        lastErrorCode = failureCode === "429" ? "rate_limited" : "provider_unavailable";
        lastErrorMessage = err.message || `Provider ${config.id} failed`;
      }
    }

    return {
      ok: false,
      provider: "none",
      model: "none",
      durationMs: 0,
      fallbackTriggered: true,
      error: {
        code: lastErrorCode,
        message:
          lastErrorCode === "privacy_blocked"
            ? lastErrorMessage
            : "AI assistance is temporarily unavailable. Core tasks, timetable, and reminders remain operational.",
      },
    };
  }

  /**
   * Legacy / Direct execution method (compatible with tests/unit_ai.ts).
   */
  public async execute<TOutput = any>(
    request: AIRequest,
    now: Date = new Date()
  ): Promise<AIResponse<TOutput>> {
    let providerOrder = this.getProviderOrder();
    if (this.db) {
      try {
        const setting = await this.db.prepare("SELECT value FROM settings WHERE key = 'disabled_providers'").first<{ value: string }>();
        if (setting?.value) {
          const disabledList = setting.value.toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
          providerOrder = providerOrder.filter(p => !disabledList.some(d => p.toLowerCase().includes(d) || d.includes(p.toLowerCase())));
        }
      } catch {}
    }
    let fallbackTriggered = false;
    let lastErrorCode: any = "provider_unavailable";
    let lastErrorMessage = "No available provider could fulfill the request";

    for (let i = 0; i < providerOrder.length; i++) {
      const providerId = providerOrder[i];
      const config = this.getProviderConfig(providerId);
      if (!config) continue;

      if (!config.allowedPrivacyClasses.includes(request.privacyClass)) {
        lastErrorCode = "privacy_blocked";
        lastErrorMessage = `Provider '${providerId}' terms do not allow privacy class '${request.privacyClass}'`;
        continue;
      }

      const circuit = getCircuitState(providerId);
      if (circuit.cooldownUntil > now.getTime()) {
        fallbackTriggered = true;
        continue;
      }

      const startTime = Date.now();
      try {
        const result = await this.callProvider<TOutput>(config, request, now);
        const durationMs = Date.now() - startTime;

        circuit.consecutiveFailures = 0;
        circuit.cooldownUntil = 0;
        circuit.avgLatencyMs = Math.round((circuit.avgLatencyMs + durationMs) / 2);
        await this.recordProviderHealth(config.id, config.model, "healthy", 0, durationMs, now);

        return {
          ok: true,
          data: result.data,
          rawText: result.rawText,
          provider: config.id,
          model: config.model,
          durationMs,
          fallbackTriggered: fallbackTriggered || i > 0,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        fallbackTriggered = true;
        circuit.consecutiveFailures++;

        let failureCode = "500";
        let cooldownMs = 5000;

        if (err.name === "AbortError" || err.message?.includes("timeout")) {
          failureCode = "timeout";
          cooldownMs = 15000;
        } else if (err.status === 429 || err.message?.includes("429")) {
          failureCode = "429";
          const retryAfterMs = err.retryAfterMs || 2000;
          cooldownMs = Math.max(retryAfterMs, 5000);
          const remainingBudget = 6000 - (Date.now() - startTime);
          if (retryAfterMs <= 2000 && remainingBudget > (retryAfterMs + 1000)) {
            try {
              await new Promise((r) => setTimeout(r, retryAfterMs));
              const retryRes = await this.callProvider<TOutput>(config, request, now);
              if (retryRes && retryRes.data) {
                circuit.consecutiveFailures = 0;
                circuit.cooldownUntil = 0;
                return {
                  ok: true,
                  data: retryRes.data,
                  rawText: retryRes.rawText,
                  provider: config.id,
                  model: config.model,
                  durationMs: Date.now() - startTime,
                  fallbackTriggered: fallbackTriggered || i > 0,
                };
              }
            } catch {
              // Retry failed, move to next candidate slot
            }
          }
        } else if (err.status >= 500 || err.message?.includes("503")) {
          failureCode = "503";
          cooldownMs = 30000;
        }

        // Permanent errors (bad key / decommissioned model): 24h disable + alert
        if (err.permanent) {
          failureCode = err.status === 401 ? "auth_failed" : "model_decommissioned";
          cooldownMs = 24 * 60 * 60 * 1000;
          circuit.consecutiveFailures = 99;
          this.sendPermanentAlert(config.id, config.model, failureCode).catch(() => {});
        } else if (circuit.consecutiveFailures >= 3) {
          cooldownMs = Math.max(cooldownMs, 300000);
        }

        circuit.cooldownUntil = Date.now() + cooldownMs;
        await this.recordProviderHealth(
          config.id,
          config.model,
          circuit.consecutiveFailures >= 3 ? "cooldown" : "degraded",
          circuit.consecutiveFailures,
          durationMs,
          now,
          failureCode
        );

        lastErrorCode = failureCode === "429" ? "rate_limited" : "provider_unavailable";
        lastErrorMessage = err.message || `Provider ${config.id} failed`;
      }
    }

    return {
      ok: false,
      provider: "none",
      model: "none",
      durationMs: 0,
      fallbackTriggered: true,
      error: {
        code: lastErrorCode,
        message:
          lastErrorCode === "privacy_blocked"
            ? lastErrorMessage
            : "AI assistance is temporarily unavailable. Core tasks, timetable, and reminders remain operational.",
      },
    };
  }

  private async callProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest,
    _now: Date
  ): Promise<{ data: TOutput; rawText: string }> {
    // Every model call carries a SYSTEM RESULTS section, including repair and retry calls.
    // Idempotent, so a prompt that already has one is untouched.
    request = { ...request, userPrompt: withSystemResults(request.userPrompt) };
    if (request.simulatedFailure && config.id !== "mock") {
      const sim = request.simulatedFailure;
      request.simulatedFailure = undefined;
      if (sim === "429") {
        const err: any = new Error("Rate limit exceeded (simulated 429)");
        err.status = 429;
        err.retryAfterMs = 1000;
        throw err;
      }
      if (sim === "503") {
        const err: any = new Error("Service Unavailable (simulated 503)");
        err.status = 503;
        throw err;
      }
      if (sim === "timeout") {
        const err: any = new Error("Request timed out (simulated)");
        err.name = "AbortError";
        throw err;
      }
      if (sim === "malformed_json") {
        const err: any = new Error("Failed to parse upstream response (simulated malformed JSON)");
        throw err;
      }
    }

    const pType = config.providerType || (config.id.startsWith("groq") ? "groq" : config.id.startsWith("gemini") ? "gemini" : config.id as any);
    switch (pType) {
      case "mock":
        return this.callMockProvider<TOutput>(config, request);
      case "groq":
        return this.callGroqProvider<TOutput>(config, request);
      case "workers_ai":
        return this.callWorkersAiProvider<TOutput>(config, request);
      case "gemini":
        return this.callGeminiProvider<TOutput>(config, request);
      case "ollama":
        return this.callOllamaProvider<TOutput>(config, request);
      default:
        throw new Error(`Unsupported provider: ${config.id}`);
    }
  }

  private async callMockProvider<TOutput>(
    _config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    let mockResult: any;

    if (request.capability === "telegram_assistant") {
      mockResult = {
        intent: "chat",
        confidence: 0,
        reply_text: "AI is offline right now. Your message was not lost.",
        offline: true,
      };
    } else if (request.capability === "task_breakdown") {
      const taskTitle = request.inputContext?.title || "Project Milestone";
      mockResult = {
        summary: `Decomposed "${taskTitle}" into 3 concrete steps`,
        subtasks: [
          {
            title: `Phase 1: Research and outline for ${taskTitle}`,
            estimated_minutes: 45,
            suggested_deadline_offset_hours: 24,
            priority: "high",
            evidence: "Foundational prerequisite",
          },
          {
            title: `Phase 2: Draft implementation of ${taskTitle}`,
            estimated_minutes: 90,
            suggested_deadline_offset_hours: 48,
            priority: "normal",
            evidence: "Core work item",
          },
          {
            title: `Phase 3: Review and finalize ${taskTitle}`,
            estimated_minutes: 30,
            suggested_deadline_offset_hours: 72,
            priority: "normal",
            evidence: "Submission verification",
          },
        ],
        reason: "Decomposed complex milestone into 3 sequential subtasks",
        confidence: 0.95,
        evidence: `Based on project title ${taskTitle}`,
        affected_record_ids: request.inputContext?.taskId ? [request.inputContext.taskId] : [],
      };
    } else if (request.capability === "weekly_plan") {
      mockResult = {
        summary: "Weekly Schedule & Preparation Plan",
        focus_areas: ["Lab Manual preparation", "Mid-week assignment deadlines"],
        bottlenecks: ["Cluster of 3 tasks on Friday"],
        proposals: [
          {
            title: "Prepare Circuit Lab calculations ahead of Thursday",
            suggested_deadline_offset_hours: 24,
            priority: "high",
            evidence: "Physics Lab slot on Friday requires manual verified",
          },
        ],
        reason: "Weekly academic and schedule synthesis",
        confidence: 0.9,
        evidence: "Timetable occurrences and upcoming assignment deadlines",
        affected_record_ids: [],
      };
    } else if (request.capability === "prioritize") {
      const firstTaskId = request.inputContext?.tasks?.[0]?.id || "task-1";
      mockResult = {
        recommended_order: [
          {
            task_id: firstTaskId,
            rank: 1,
            urgency_score: 9.5,
            reasoning: "Imminent deadline with high priority",
          },
        ],
        summary: "Prioritized based on strict deadline urgency and preparation lead times",
        reason: "Urgency deadline scoring",
        confidence: 0.95,
        evidence: "Earliest deadline and high priority tag",
        affected_record_ids: [firstTaskId],
      };
    } else if ((request.capability as string) === "telegram_assistant") {
      const uText = (request.inputContext?.userText || "").toLowerCase();
      if (/weather|temperature/i.test(uText)) {
        mockResult = {
          intent: "lookup",
          confidence: 0.95,
          reply_text: "Checking weather...",
          lookup: { kind: "weather", query: request.inputContext?.userText || "" },
        };
      } else if (/remind|task|buy|pick up|study|submit|groceries/i.test(uText)) {
        mockResult = {
          intent: "explicit_task",
          confidence: 0.95,
          reply_text: "Got it.",
          tasks: [{ title: request.inputContext?.userText?.slice(0, 40) || "Task", offset_days: 0, anchor: "none" }],
        };
      } else {
        mockResult = {
          intent: "chat",
          confidence: 0.95,
          reply_text: "Hey! What's up?",
        };
      }
    } else {
      mockResult = {
        next_action: "Review upcoming timetable and tackle overdue items",
        rationale: "Derived from timetable context and urgent task priority",
        confidence: 0.95,
        reason: "Derived from timetable context and urgent task priority",
        evidence: "Current timetable slot and overdue tasks list",
        affected_record_ids: [],
      };
    }

    // Mock output is explicitly labeled so callers can surface "AI offline" in UX
    const rawText = JSON.stringify({ ...mockResult, _mock: true, _offline_label: "AI offline" });
    return { data: mockResult as TOutput, rawText };
  }

  private async callGroqProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const apiKey = config.apiKey || this.resolveApiKey("groq", config.keySlot || 1);
    if (!apiKey) throw new Error(`Groq API key not configured for profile '${config.id}' (slot ${config.keySlot || 1})`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    // Plain-text paths must NOT use json_object mode (Groq wraps reply in JSON object)
    const isPlainText = request.responseFormat === "text";

    // Prefer a strict JSON schema when the capability declares one, so the provider
    // enforces the shape instead of us hoping the prompt did.
    const strictFormat = !isPlainText && request.outputSchema
      ? { type: "json_schema", json_schema: { name: "daemon_output", strict: true, schema: toStrictJsonSchema(request.outputSchema) } }
      : null;
    const jsonObjectFormat = isPlainText ? {} : { type: "json_object" };

    const sendGroq = (responseFormat: any) =>
      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt },
          ],
          ...(isPlainText ? {} : { response_format: responseFormat }),
          temperature: resolveTemperature(request.temperature),
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

    try {
      let response = await sendGroq(strictFormat || jsonObjectFormat);

      // A model that rejects the schema should still answer in JSON rather than take the
      // whole turn down, so downgrade exactly once instead of failing the provider.
      if (!response.ok && strictFormat && response.status === 400) {
        const firstBody = await response.text().catch(() => "");
        if (/response_format|json_schema|schema/i.test(firstBody)) {
          console.warn("[Groq] json_schema rejected, retrying with json_object:", firstBody.slice(0, 160));
          response = await sendGroq(jsonObjectFormat);
        } else {
          const err: any = new Error(`Groq API error: 400`);
          err.status = 400;
          err.body = firstBody;
          throw err;
        }
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "(unreadable)");
        console.error("[Groq] HTTP", response.status, "error:", errorBody.slice(0, 300));
        const err: any = new Error(`Groq API error: ${response.status}`);
        err.status = response.status;
        err.body = errorBody;
        if (response.status === 429) {
          const retryHeader = response.headers.get("retry-after");
          const retrySec = retryHeader ? parseFloat(retryHeader) : NaN;
          err.retryAfterMs = !isNaN(retrySec) ? Math.min(Math.round(retrySec * 1000), 10000) : 2000;
        }
        if (response.status === 401 || response.status === 404 ||
            errorBody.includes("decommissioned") || errorBody.includes("model_not_found")) {
          err.permanent = true;
        }
        throw err;
      }

      const resJson = (await response.json()) as any;
      const rawText = resJson.choices?.[0]?.message?.content || (isPlainText ? "" : "{}");
      const data = isPlainText ? ((rawText as any) as TOutput) : this.extractJsonPayload<TOutput>(rawText);
      return { data, rawText };
    } finally {
      clearTimeout(timeout);
    }
  }  /**
   * Returns plain text as-is for responseFormat: "text" requests; otherwise strict JSON.
   * Providers share this so plain-text answers never get JSON-ified.
   */
  private parseProviderOutput<T>(rawText: string, isPlainText: boolean): T {
    return (isPlainText ? (rawText as any) : this.extractJsonPayload<T>(rawText)) as T;
  }

  private extractJsonPayload<T = any>(rawText: any): T {
  const textStr = typeof rawText === "string" ? rawText : JSON.stringify(rawText || "{}");
  const trimmed = textStr.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch {}
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }

  const startArr = trimmed.indexOf("[");
  const endArr = trimmed.lastIndexOf("]");
  if (startArr !== -1 && endArr > startArr) {
    try {
      return JSON.parse(trimmed.slice(startArr, endArr + 1));
    } catch {}
  }

  throw new Error(`Failed to parse JSON output: ${trimmed.slice(0, 150)}`);
}

  private async callWorkersAiProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const aiBinding = this.env?.AI;
    if (!aiBinding) throw new Error("Cloudflare Workers AI binding (env.AI) not configured");

    const isPlainTextWai = request.responseFormat === "text";

    const response: any = await aiBinding.run(config.model, {
      messages: [
        { role: "system", content: isPlainTextWai ? request.systemPrompt : `${request.systemPrompt}\n\nIMPORTANT: Return valid JSON only.` },
        { role: "user", content: request.userPrompt },
      ],
      max_tokens: 1024,
      temperature: resolveTemperature(request.temperature),
    });

    const rawText = typeof response === "string" ? response : typeof response?.response === "string" ? response.response : JSON.stringify(response);
    let waiData: TOutput;
    if (isPlainTextWai) {
      waiData = (rawText as any) as TOutput;
    } else {
      let parsed: any = null;
      try {
        parsed = this.extractJsonPayload<any>(rawText);
      } catch {
        // non-JSON
      }

      if (request.capability === "telegram_assistant") {
        if (parsed && typeof parsed === "object" && parsed.intent && typeof parsed.confidence === "number") {
          waiData = parsed as TOutput;
        } else {
          // Normalize Workers AI output (which may be {response: "..."}, plain text, or partial JSON)
          const textCandidate = (parsed && typeof parsed === "object")
            ? (parsed.reply_text || parsed.response || parsed.message || parsed.text || JSON.stringify(parsed))
            : rawText;
          const cleanText = String(textCandidate || "Hey! How can I help you today?").trim().replace(/^[\s{"}]+/, "").slice(0, 500);
          waiData = {
            intent: "chat",
            confidence: 0.85,
            reply_text: cleanText || "Hey! How can I help you today?",
          } as TOutput;
        }
      } else {
        if (!parsed) {
          throw new Error(`Workers AI response is not valid JSON: ${rawText.slice(0, 150)}`);
        }
        waiData = parsed as TOutput;
      }
    }
    return { data: waiData, rawText };
  }

  private async callGeminiProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const apiKey = config.apiKey || this.resolveApiKey("gemini", config.keySlot || 1);
    if (!apiKey) throw new Error(`Gemini API key not configured for profile '${config.id}' (slot ${config.keySlot || 1})`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 15000);

    const isPlainText = request.responseFormat === "text";

    const payload: any = {
      contents: [{ parts: [{ text: `${request.systemPrompt}\n\n${request.userPrompt}` }] }],
      generationConfig: {
        temperature: resolveTemperature(request.temperature),
        ...(isPlainText
          ? {}
          : {
              responseMimeType: "application/json",
              ...(request.outputSchema ? { responseSchema: toGeminiSchema(request.outputSchema) } : {}),
            }),
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
      let response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "(unreadable)");
        console.error("[Gemini] HTTP", response.status, "error:", errorBody.slice(0, 300));
        // No retry probe here: a second live request from inside an error handler doubles
        // the failure latency and spends the fallback budget for no new information.
        const err: any = new Error(`Gemini API error: ${response.status}`);
        err.status = response.status;
        err.body = errorBody;
        if (response.status === 429) {
          const retryHeader = response.headers.get("retry-after");
          const retrySec = retryHeader ? parseFloat(retryHeader) : NaN;
          err.retryAfterMs = !isNaN(retrySec) ? Math.min(Math.round(retrySec * 1000), 10000) : 2000;
        }
        if (response.status === 401 || response.status === 404 ||
            errorBody.includes("decommissioned") || errorBody.includes("INVALID_ARGUMENT")) {
          err.permanent = true;
        }
        throw err;
      }

      const resJson = (await response.json()) as any;
      const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || (isPlainText ? "" : "{}");
      const data = this.parseProviderOutput<TOutput>(rawText, request.responseFormat === "text");
      return { data, rawText };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Local Ollama Provider Implementation (Prepared for Block 9 Desktop Agent).
   */
  private async callOllamaProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const host = this.env?.OLLAMA_HOST || "http://localhost:11434";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    // Plain-text paths must NOT use json_object mode (Groq wraps reply in JSON object)
    const isPlainText = request.responseFormat === "text";

    try {
      const response = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          prompt: `${request.systemPrompt}\n\n${request.userPrompt}`,
          format: "json",
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err: any = new Error(`Ollama local error: ${response.status}`);
        err.status = response.status;
        throw err;
      }

      const resJson = (await response.json()) as any;
      const rawText = resJson.response || "{}";
      const data = this.parseProviderOutput<TOutput>(rawText, request.responseFormat === "text");
      return { data, rawText };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Records provider health telemetry in D1 (SRS §8.12).
   * Strictly omits prompt text, user messages, or model outputs (Privacy scrubbing).
   */
  private async recordProviderHealth(
    provider: string,
    model: string,
    status: "healthy" | "cooldown" | "degraded" | "offline",
    consecutiveFailures: number,
    durationMs: number,
    now: Date = new Date(),
    lastFailureCode?: string
  ): Promise<void> {
    if (!this.db) return;
    const nowIso = now.toISOString();

    try {
      await this.db
        .prepare(
          `INSERT INTO provider_health (
             provider, model, status, consecutive_failures, cooldown_until,
             last_success_at, last_failure_at, last_failure_code,
             total_requests, total_tokens, avg_latency_ms, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             status = excluded.status,
             consecutive_failures = excluded.consecutive_failures,
             last_success_at = CASE WHEN excluded.consecutive_failures = 0 THEN excluded.last_success_at ELSE provider_health.last_success_at END,
             last_failure_at = CASE WHEN excluded.consecutive_failures > 0 THEN excluded.last_failure_at ELSE provider_health.last_failure_at END,
             last_failure_code = excluded.last_failure_code,
             total_requests = provider_health.total_requests + 1,
             avg_latency_ms = (provider_health.avg_latency_ms + excluded.avg_latency_ms) / 2,
             updated_at = excluded.updated_at`
        )
        .bind(
          provider,
          model,
          status,
          consecutiveFailures,
          status === "cooldown" ? new Date(now.getTime() + 300000).toISOString() : null,
          status === "healthy" ? nowIso : null,
          status !== "healthy" ? nowIso : null,
          lastFailureCode || null,
          durationMs,
          nowIso
        )
        .run();
    } catch (e) {
      console.warn("[ProviderHealth Telemetry Warning]", e);
    }
  }

  /**
   * Sends a Telegram alert when a provider is permanently disabled.
   * Best-effort: never throws.
   */
  private async sendPermanentAlert(providerId: string, modelId: string, reason: string): Promise<void> {
    try {
      // F5: No alerts for test runs
      if (this.env?.ALLOW_TEST_STUBS === "1") return;

      const token = this.env?.TELEGRAM_BOT_TOKEN;
      const chatId = this.env?.TELEGRAM_OWNER_ID;
      if (!token || !chatId) return;

      // F5: Check D1 provider_alerts for max 1 per state change and max 1 per 24h
      if (this.db) {
        const existing = await this.db
          .prepare("SELECT last_state, last_alert_at FROM provider_alerts WHERE provider = ?")
          .bind(providerId)
          .first<{ last_state: string; last_alert_at: string }>()
          .catch(() => null);

        if (existing) {
          const hoursSinceLast = (Date.now() - new Date(existing.last_alert_at).getTime()) / (1000 * 3600);
          if (existing.last_state === reason && hoursSinceLast < 24) {
            return; // Deduplicated
          }
        }

        const nowIso = new Date().toISOString();
        await this.db
          .prepare(
            `INSERT OR REPLACE INTO provider_alerts (provider, last_state, last_alert_at, updated_at)
             VALUES (?, ?, ?, ?)`
          )
          .bind(providerId, reason, nowIso, nowIso)
          .run()
          .catch(() => {});
      }

      const msg = `[AI Alert] Provider ${providerId} (model: ${modelId}) state changed to: ${reason}.`;
      await sendTelegramMessage(token, chatId, msg);
    } catch {
      // best-effort
    }
  }

  /**
   * Canary: tiny structured-JSON ping through real adapter path per provider.
   * Classifies permanent (401/404/decommissioned) vs transient errors.
   * Records results in provider_health. Never throws.
   */
  public async runCanary(now: Date = new Date()): Promise<Record<string, { ok: boolean; latencyMs: number; error?: string; permanent?: boolean }>> {
    const isGeminiParked = this.env?.GEMINI_ENABLED !== "1";
    const targetProviders = [
      "groq_primary",
      "groq_secondary",
      ...(isGeminiParked ? [] : ["gemini_primary", "gemini_secondary"]),
      "workers_ai",
    ];
    const results: Record<string, { ok: boolean; latencyMs: number; error?: string; permanent?: boolean }> = {};
    const canaryRequest: AIRequest = {
      capability: "suggest_next",
      systemPrompt: 'Reply with valid JSON: {"ok":true}',
      userPrompt: "Canary ping",
      inputContext: { canary: true },
      privacyClass: "synthetic_test",
    };
    for (const providerId of targetProviders) {
      if (providerId === "mock") { results["mock"] = { ok: true, latencyMs: 0 }; continue; }
      const config = this.getProviderConfig(providerId);
      if (!config) continue;
      const start = Date.now();
      try {
        await this.callProvider(config, canaryRequest, now);
        const latencyMs = Date.now() - start;
        results[providerId] = { ok: true, latencyMs };
        await this.recordProviderHealth(config.id, config.model, "healthy", 0, latencyMs, now);
      } catch (err: any) {
        const latencyMs = Date.now() - start;
        const isPermanent = !!(err.permanent);
        const errMsg = (err.message || "unknown") + (err.body ? " | body: " + String(err.body).slice(0, 200) : "");
        results[providerId] = { ok: false, latencyMs, error: errMsg, permanent: isPermanent };
        const failCode = isPermanent
          ? (err.status === 401 ? "auth_failed" : "model_decommissioned")
          : (err.status === 429 ? "429" : (err.status?.toString() || "error"));
        await this.recordProviderHealth(config.id, config.model, isPermanent ? "cooldown" : "degraded", 99, latencyMs, now, failCode);
        if (isPermanent) await this.sendPermanentAlert(config.id, config.model, failCode);
      }
    }
    return results;
  }


  /**
   * Sends a Telegram alert when a provider is permanently disabled.
   * Best-effort: never throws.
   */
}
