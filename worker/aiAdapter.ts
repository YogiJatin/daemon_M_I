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

export type PrivacyClass = "synthetic_test" | "low_sensitivity" | "personal" | "restricted";

export interface AIRequest<TInput = any> {
  capability: "task_breakdown" | "weekly_plan" | "prioritize" | "suggest_next" | "propose_task";
  systemPrompt: string;
  userPrompt: string;
  inputContext: TInput;
  privacyClass: PrivacyClass;
  outputSchema?: Record<string, any>;
  timeoutMs?: number; // default: 6000ms
  correlationId?: string;
  simulatedFailure?: "429" | "503" | "timeout" | "malformed_json" | "privacy_blocked"; // for test suites
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
  id: string; // 'groq' | 'workers_ai' | 'gemini' | 'ollama' | 'mock'
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
    const custom = this.env?.AI_PROVIDER_ORDER || "groq,workers_ai,mock";
    return custom
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  public getProviderConfig(providerId: string): ProviderConfig | null {
    switch (providerId.toLowerCase()) {
      case "groq":
        return {
          id: "groq",
          model: this.env?.GROQ_MODEL || "llama-3.3-70b-versatile",
          allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
          timeoutMs: 6000,
        };
      case "workers_ai":
        return {
          id: "workers_ai",
          model: this.env?.WORKERS_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct",
          allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal"],
          timeoutMs: 8000,
        };
      case "gemini":
        return {
          id: "gemini",
          model: this.env?.GEMINI_MODEL || "gemini-2.0-flash",
          allowedPrivacyClasses: ["synthetic_test", "low_sensitivity"],
          timeoutMs: 7000,
        };
      case "ollama":
        return {
          id: "ollama",
          model: this.env?.OLLAMA_MODEL || "llama3.2:latest",
          allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal", "restricted"],
          timeoutMs: 10000,
        };
      case "mock":
        return {
          id: "mock",
          model: "deterministic-mock-v1",
          allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal", "restricted"],
          timeoutMs: 500,
        };
      default:
        return null;
    }
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
    const ownerOrder = this.getProviderOrder();
    const allConfigs = ["groq", "workers_ai", "gemini", "mock"]
      .map((id) => this.getProviderConfig(id))
      .filter((c): c is ProviderConfig => c !== null);

    const scoredCandidates = AIProviderScoring.rankCandidates(allConfigs, ownerOrder, privacyClass, circuitStates, now);

    let fallbackTriggered = false;
    let lastErrorCode: any = "provider_unavailable";
    let lastErrorMessage = "All candidate providers failed or are unavailable";

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

      const circuit = getCircuitState(config.id);
      const startTime = Date.now();

      try {
        const req: AIRequest = {
          capability: capability.id as any,
          systemPrompt: capability.systemRules,
          userPrompt: canonicalXml,
          inputContext: input,
          privacyClass,
          simulatedFailure,
        };

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
          cooldownMs = err.retryAfterMs || 60000;
        } else if (err.status >= 500 || err.message?.includes("503")) {
          failureCode = "503";
          cooldownMs = 30000;
        }

        if (circuit.consecutiveFailures >= 3) {
          cooldownMs = Math.max(cooldownMs, 300000);
        }

        circuit.cooldownUntil = now.getTime() + cooldownMs;
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
    const providerOrder = this.getProviderOrder();
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
          cooldownMs = err.retryAfterMs || 60000;
        } else if (err.status >= 500 || err.message?.includes("503")) {
          failureCode = "503";
          cooldownMs = 30000;
        }

        if (circuit.consecutiveFailures >= 3) {
          cooldownMs = Math.max(cooldownMs, 300000);
        }

        circuit.cooldownUntil = now.getTime() + cooldownMs;
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

    switch (config.id.toLowerCase()) {
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

    if (request.capability === "task_breakdown") {
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

    const rawText = JSON.stringify(mockResult);
    return { data: mockResult as TOutput, rawText };
  }

  private async callGroqProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const apiKey = this.env?.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY not configured");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err: any = new Error(`Groq API error: ${response.status}`);
        err.status = response.status;
        throw err;
      }

      const resJson = (await response.json()) as any;
      const rawText = resJson.choices?.[0]?.message?.content || "{}";
      const data = JSON.parse(rawText) as TOutput;
      return { data, rawText };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callWorkersAiProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const aiBinding = this.env?.AI;
    if (!aiBinding) throw new Error("Cloudflare Workers AI binding (env.AI) not configured");

    const promptText = `${request.systemPrompt}\n\nIMPORTANT: Return valid JSON only.\n\n${request.userPrompt}`;
    const response: any = await aiBinding.run(config.model, {
      prompt: promptText,
      max_tokens: 1024,
      temperature: 0.1,
    });

    const rawText = typeof response === "string" ? response : response?.response || JSON.stringify(response);
    const data = JSON.parse(rawText) as TOutput;
    return { data, rawText };
  }

  private async callGeminiProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const apiKey = this.env?.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${request.systemPrompt}\n\n${request.userPrompt}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
      }),
    });

    if (!response.ok) {
      const err: any = new Error(`Gemini API error: ${response.status}`);
      err.status = response.status;
      throw err;
    }

    const resJson = (await response.json()) as any;
    const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const data = JSON.parse(rawText) as TOutput;
    return { data, rawText };
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
      const data = JSON.parse(rawText) as TOutput;
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
}
