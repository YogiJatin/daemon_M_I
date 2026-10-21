/**
 * worker/aiProviderScoring.ts
 *
 * Dedicated Provider Scoring & Selection Engine for Personal AI OS.
 *
 * Selection Rules (Owner Primacy):
 * 1. Owner Preference (order from env.AI_PROVIDER_ORDER)
 * 2. Filter Healthy Providers (exclude providers currently in circuit cooldown)
 * 3. Filter Privacy Compatible (exclude providers whose terms disallow the request's privacy class)
 * 4. Lowest Latency & Lowest Cost (as tie-breaker among eligible providers)
 *
 * Rule: NEVER override owner preference unless the provider is unavailable, unhealthy, or violating privacy tier.
 */

import { PrivacyClass, ProviderConfig } from "./aiAdapter";

export interface ProviderHealthMetrics {
  provider: string;
  consecutiveFailures: number;
  cooldownUntil: number; // ms timestamp
  avgLatencyMs: number;
  estimatedCostPerToken: number;
}

export interface ScoredCandidate {
  config: ProviderConfig;
  ownerRank: number; // 0 is top owner choice
  isHealthy: boolean;
  isPrivacyAllowed: boolean;
  compositeScore: number;
  disqualificationReason?: string;
}

export class AIProviderScoring {
  /**
   * Evaluates candidate providers and ranks them respecting Owner Primacy.
   */
  public static rankCandidates(
    configs: ProviderConfig[],
    ownerOrder: string[],
    privacyClass: PrivacyClass,
    healthMap: Map<string, { consecutiveFailures: number; cooldownUntil: number; avgLatencyMs: number }>,
    now: Date = new Date()
  ): ScoredCandidate[] {
    const candidates: ScoredCandidate[] = [];
    const nowMs = now.getTime();

    // Map provider to its position in owner's preferred order
    const ownerRankMap = new Map<string, number>();
    ownerOrder.forEach((p, idx) => ownerRankMap.set(p.toLowerCase(), idx));

    for (const config of configs) {
      const pid = config.id.toLowerCase();
      const ownerRank = ownerRankMap.has(pid) ? ownerRankMap.get(pid)! : 999;

      const health = healthMap.get(pid) || { consecutiveFailures: 0, cooldownUntil: 0, avgLatencyMs: 200 };
      const isHealthy = health.cooldownUntil <= nowMs;
      const isPrivacyAllowed = config.allowedPrivacyClasses.includes(privacyClass);

      let reason: string | undefined;
      if (!isPrivacyAllowed) {
        reason = `Privacy class '${privacyClass}' not permitted`;
      } else if (!isHealthy) {
        reason = `Provider in cooldown until ${new Date(health.cooldownUntil).toISOString()}`;
      }

      // Score formula giving overwhelming weight to owner preference (10,000 pts per rank)
      // while factoring in latency (lower latency = slight bonus)
      const latencyBonus = Math.max(0, 1000 - health.avgLatencyMs);
      const compositeScore = (1000 - ownerRank * 100) * 10 + latencyBonus;

      candidates.push({
        config,
        ownerRank,
        isHealthy,
        isPrivacyAllowed,
        compositeScore,
        disqualificationReason: reason,
      });
    }

    // Sort:
    // 1. Fully eligible (healthy + privacy allowed) come first
    // 2. Sorted by owner preference rank ascending (0 is top)
    // 3. Tie-break on compositeScore (latency)
    return candidates.sort((a, b) => {
      const aEligible = a.isHealthy && a.isPrivacyAllowed;
      const bEligible = b.isHealthy && b.isPrivacyAllowed;

      if (aEligible && !bEligible) return -1;
      if (!aEligible && bEligible) return 1;

      if (a.ownerRank !== b.ownerRank) {
        return a.ownerRank - b.ownerRank;
      }

      return b.compositeScore - a.compositeScore;
    });
  }
}
