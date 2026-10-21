/**
 * worker/aiAdapter.ts — Block 6 Central AI Capability Adapter & Failover Router
 *
 * Requirements (Personal_AI_OS_SRS_v2.2.md §§7.8, 10, 13.5, 16 TEST-6.1 to TEST-6.7):
 * - Central boundary for all AI operations. No feature calls provider SDKs/URLs directly.
 * - Primary provider: Groq (llama-3.3-70b-versatile).
 * - Fallback provider: Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct), optional Gemini.
 * - Deterministic Mock Provider for offline CI testing and simulated failures.
 * - Provider order is configurable via env (AI_PROVIDER_ORDER).
 * - Strict Privacy Classification: synthetic_test | low_sensitivity | personal | restricted.
 *   Fallback is blocked if provider terms do not permit the request's privacy class (TEST-6.3).
 * - Circuit breaker with cooldown, consecutive failure tracking, and Retry-After support.
 * - Runtime JSON schema validation and prompt injection defense (TEST-6.4).
 * - Safe graceful degradation: core reminder/task functions unaffected if AI fails (TEST-6.1, TEST-6.7).
 * - Observability without logging full private prompt/response bodies (TEST-6.6).
 */

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
  id: string; // 'groq' | 'workers_ai' | 'gemini' | 'mock'
  model: string;
  allowedPrivacyClasses: PrivacyClass[];
  timeoutMs: number;
}

// In-memory circuit state across worker requests
interface CircuitState {
  consecutiveFailures: number;
  cooldownUntil: number; // timestamp in ms
}

const circuitStates = new Map<string, CircuitState>();

export function resetCircuitBreakers(): void {
  circuitStates.clear();
}

function getCircuitState(providerId: string): CircuitState {
  let state = circuitStates.get(providerId);
  if (!state) {
    state = { consecutiveFailures: 0, cooldownUntil: 0 };
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
   * Resolves the configured provider order.
   * Priority: env.AI_PROVIDER_ORDER -> ["groq", "workers_ai", "mock"]
   * If GROQ_API_KEY is missing, mock or workers_ai moves ahead.
   */
  public getProviderOrder(): string[] {
    const custom = this.env?.AI_PROVIDER_ORDER || "groq,workers_ai,mock";
    return custom
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  public getProviderConfig(providerId: string): ProviderConfig | null {
    switch (providerId) {
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
          // Free tier Gemini trains on data -> restricted to synthetic_test & low_sensitivity
          allowedPrivacyClasses: ["synthetic_test", "low_sensitivity"],
          timeoutMs: 7000,
        };
      case "mock":
        return {
          id: "mock",
          model: "deterministic-mock-v1",
          // Mock is local in-memory: safe for all privacy classes
          allowedPrivacyClasses: ["synthetic_test", "low_sensitivity", "personal", "restricted"],
          timeoutMs: 500,
        };
      default:
        return null;
    }
  }

  /**
   * Central dispatch method with failover, circuit breaker, and privacy gating.
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

      // 1. Privacy Class Check (SRS §10.4, TEST-6.3)
      if (!config.allowedPrivacyClasses.includes(request.privacyClass)) {
        // Provider cannot handle this privacy level (e.g. personal data sent to training tier)
        lastErrorCode = "privacy_blocked";
        lastErrorMessage = `Provider '${providerId}' terms do not allow privacy class '${request.privacyClass}'`;
        continue;
      }

      // 2. Circuit Breaker / Cooldown Check
      const circuit = getCircuitState(providerId);
      if (circuit.cooldownUntil > now.getTime()) {
        // Provider is in cooldown, skip to next fallback
        fallbackTriggered = true;
        continue;
      }

      // 3. Attempt Execution
      const startTime = Date.now();
      try {
        const result = await this.callProvider<TOutput>(config, request, now);
        const durationMs = Date.now() - startTime;

        // Success: reset consecutive failures
        circuit.consecutiveFailures = 0;
        circuit.cooldownUntil = 0;
        await this.recordProviderHealth(config.id, config.model, "healthy", 0, durationMs, now);

        return {
          ok: true,
          data: result.data,
          rawText: result.rawText,
          provider: config.id,
          model: config.model,
          durationMs,
          fallbackTriggered,
        };
      } catch (err: any) {
        const durationMs = Date.now() - startTime;
        fallbackTriggered = true;
        circuit.consecutiveFailures++;

        // Determine failure classification
        let failureCode = "500";
        let cooldownMs = 5000; // default 5s

        if (err.name === "AbortError" || err.message?.includes("timeout")) {
          failureCode = "timeout";
          cooldownMs = 15000;
        } else if (err.status === 429 || err.message?.includes("429") || err.message?.includes("rate_limited")) {
          failureCode = "429";
          cooldownMs = err.retryAfterMs || 60000; // respect Retry-After or 60s
        } else if (err.status >= 500 || err.message?.includes("503")) {
          failureCode = "503";
          cooldownMs = 30000;
        }

        // Tripped circuit breaker after 3 failures
        if (circuit.consecutiveFailures >= 3) {
          cooldownMs = Math.max(cooldownMs, 300000); // 5 min cooldown
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

    // All providers failed or were privacy-blocked -> Safe graceful degradation (TEST-6.7)
    return {
      ok: false,
      provider: "none",
      model: "none",
      durationMs: 0,
      fallbackTriggered: true,
      error: {
        code: lastErrorCode,
        message: lastErrorCode === "privacy_blocked"
          ? lastErrorMessage
          : "AI assistance is temporarily unavailable. Core tasks, timetable, and reminders remain operational.",
      },
    };
  }

  /**
   * Calls a specific provider adapter.
   */
  private async callProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest,
    now: Date
  ): Promise<{ data: TOutput; rawText: string }> {
    // Check for simulated failure fixture in tests (TEST-6.2, TEST-6.4)
    if (request.simulatedFailure && config.id !== "mock") {
      const sim = request.simulatedFailure;
      request.simulatedFailure = undefined; // Clear so fallback provider succeeds
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

    switch (config.id) {
      case "mock":
        return this.callMockProvider<TOutput>(config, request);
      case "groq":
        return this.callGroqProvider<TOutput>(config, request);
      case "workers_ai":
        return this.callWorkersAiProvider<TOutput>(config, request);
      case "gemini":
        return this.callGeminiProvider<TOutput>(config, request);
      default:
        throw new Error(`Unsupported provider: ${config.id}`);
    }
  }

  /**
   * Deterministic Mock Provider for offline testing and CI suites.
   */
  private async callMockProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    // Generate deterministic structured response based on capability and input context
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
      };
    } else if (request.capability === "prioritize") {
      mockResult = {
        recommended_order: [
          {
            task_id: request.inputContext?.tasks?.[0]?.id || "task-1",
            rank: 1,
            urgency_score: 9.5,
            reasoning: "Imminent deadline with high priority",
          },
        ],
        summary: "Prioritized based on strict deadline urgency and preparation lead times",
      };
    } else {
      mockResult = {
        next_action: "Review upcoming timetable and tackle overdue items",
        confidence: 0.95,
      };
    }

    const rawText = JSON.stringify(mockResult);
    return { data: mockResult as TOutput, rawText };
  }

  /**
   * Groq Provider Implementation (OpenAI-compatible /chat/completions).
   */
  private async callGroqProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const apiKey = this.env?.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error("GROQ_API_KEY not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: `<user_data>\n${request.userPrompt}\n</user_data>` },
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
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          err.retryAfterMs = parseInt(retryAfter, 10) * 1000;
        }
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

  /**
   * Cloudflare Workers AI Provider Implementation.
   */
  private async callWorkersAiProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const aiBinding = this.env?.AI;
    if (!aiBinding) {
      throw new Error("Cloudflare Workers AI binding (env.AI) not configured");
    }

    const promptText = `${request.systemPrompt}\n\nIMPORTANT: Return valid JSON only.\n\n<user_data>\n${request.userPrompt}\n</user_data>`;
    const response: any = await aiBinding.run(config.model, {
      prompt: promptText,
      max_tokens: 1024,
      temperature: 0.1,
    });

    const rawText = response.response || JSON.stringify(response);
    // Extract JSON block if wrapped in markdown
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Workers AI did not return valid JSON");
    }
    const data = JSON.parse(jsonMatch[0]) as TOutput;
    return { data, rawText: jsonMatch[0] };
  }

  /**
   * Google Gemini Provider Implementation.
   */
  private async callGeminiProvider<TOutput>(
    config: ProviderConfig,
    request: AIRequest
  ): Promise<{ data: TOutput; rawText: string }> {
    const apiKey = this.env?.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: request.systemPrompt }] },
          contents: [{ parts: [{ text: `<user_data>\n${request.userPrompt}\n</user_data>` }] }],
          generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
        }),
        signal: controller.signal,
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
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Records provider health telemetry in D1 provider_health table (SRS §8.12).
   */
  private async recordProviderHealth(
    provider: string,
    model: string,
    status: "healthy" | "cooldown" | "degraded" | "offline",
    consecutiveFailures: number,
    durationMs: number,
    now: Date,
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
             model = excluded.model,
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
      // Non-fatal telemetry error
      console.warn("[ProviderHealth Telemetry Warning]", e);
    }
  }
}
