/**
 * worker/browserPolicy.ts — Browser Security Policy & Isolation Engine
 *
 * Requirements:
 * - Domain / URL pattern classification:
 *   trusted, restricted, read-only, safe-browser-only, blocked, owner-approved-only
 * - Isolation levels:
 *   standard, incognito_profile, disposable_sandbox
 * - Default policies for streaming, ad-heavy, or unverified sites
 */

export type BrowserPolicyType =
  | 'trusted'
  | 'restricted'
  | 'read-only'
  | 'safe-browser-only'
  | 'blocked'
  | 'owner-approved-only';

export type IsolationLevel = 'standard' | 'incognito_profile' | 'disposable_sandbox';

export interface BrowserPolicyEvaluation {
  url: string;
  domain: string;
  policy: BrowserPolicyType;
  isolationLevel: IsolationLevel;
  reason: string;
  isBlocked: boolean;
  requiresOwnerApproval: boolean;
}

export class BrowserPolicyEngine {
  private static DEFAULT_POLICIES: Array<{
    pattern: RegExp;
    policy: BrowserPolicyType;
    isolationLevel: IsolationLevel;
    reason: string;
  }> = [
    // Risky / streaming / ad-heavy domains
    {
      pattern: /(anime|stream|torrent|pirate|watchfree|mirror|fmovies|kisscartoon)\./i,
      policy: 'safe-browser-only',
      isolationLevel: 'disposable_sandbox',
      reason: 'Known ad-heavy or untrusted media domain pattern.',
    },
    // Suspicious TLDs
    {
      pattern: /\.(xyz|top|work|click|link|stream|to|cc|is|ru)$/i,
      policy: 'safe-browser-only',
      isolationLevel: 'disposable_sandbox',
      reason: 'High-risk or disposable top-level domain.',
    },
    // Internal localhost or RFC 1918
    {
      pattern: /^(localhost|127\.0\.0\.1|192\.168\.|10\.)/i,
      policy: 'trusted',
      isolationLevel: 'standard',
      reason: 'Local network development origin.',
    },
    // Reputable platforms
    {
      pattern: /(github\.com|google\.com|wikipedia\.org|stackoverflow\.com|cloudflare\.com)$/i,
      policy: 'trusted',
      isolationLevel: 'standard',
      reason: 'Allowlisted development/reference platform.',
    },
  ];

  /**
   * Evaluates a URL against dynamic D1 policies and built-in safety rules.
   */
  static async evaluate(db: D1Database, rawUrl: string): Promise<BrowserPolicyEvaluation> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return {
        url: rawUrl,
        domain: 'invalid',
        policy: 'blocked',
        isolationLevel: 'disposable_sandbox',
        reason: 'Malformed or invalid URL string.',
        isBlocked: true,
        requiresOwnerApproval: false,
      };
    }

    const domain = parsed.hostname.toLowerCase();

    // 1. Check custom policies in D1 database
    const customRow = await db
      .prepare(`SELECT * FROM browser_policies WHERE ? LIKE pattern OR pattern = ?`)
      .bind(domain, domain)
      .first<any>();

    if (customRow) {
      return {
        url: rawUrl,
        domain,
        policy: customRow.policy,
        isolationLevel: customRow.isolation_level,
        reason: customRow.reason || 'User-defined domain policy rule.',
        isBlocked: customRow.policy === 'blocked',
        requiresOwnerApproval:
          customRow.policy === 'owner-approved-only' || customRow.policy === 'restricted',
      };
    }

    // 2. Check built-in safety heuristics
    for (const rule of this.DEFAULT_POLICIES) {
      if (rule.pattern.test(domain)) {
        return {
          url: rawUrl,
          domain,
          policy: rule.policy,
          isolationLevel: rule.isolationLevel,
          reason: rule.reason,
          isBlocked: rule.policy === 'blocked',
          requiresOwnerApproval: rule.policy === 'owner-approved-only',
        };
      }
    }

    // 3. Default fallback for unknown external sites: safe-browser-only with incognito profile
    return {
      url: rawUrl,
      domain,
      policy: 'safe-browser-only',
      isolationLevel: 'incognito_profile',
      reason: 'Default-isolated boundary for unverified external domain.',
      isBlocked: false,
      requiresOwnerApproval: false,
    };
  }

  /**
   * Adds or updates a custom browser policy rule in D1.
   */
  static async setPolicy(
    db: D1Database,
    input: {
      pattern: string;
      policy: BrowserPolicyType;
      isolationLevel?: IsolationLevel;
      reason?: string;
    },
    now: Date = new Date()
  ): Promise<void> {
    const id = `bpol_${crypto.randomUUID()}`;
    const pattern = input.pattern.trim().toLowerCase();
    const isolationLevel = input.isolationLevel || 'standard';
    const reason = input.reason?.trim() || null;
    const nowIso = now.toISOString();

    await db
      .prepare(
        `INSERT INTO browser_policies (id, pattern, policy, isolation_level, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pattern) DO UPDATE SET
           policy = excluded.policy,
           isolation_level = excluded.isolation_level,
           reason = excluded.reason`
      )
      .bind(id, pattern, input.policy, isolationLevel, reason, nowIso)
      .run();
  }

  /**
   * Lists all custom browser policies.
   */
  static async listPolicies(db: D1Database): Promise<any[]> {
    const rows = await db
      .prepare(`SELECT * FROM browser_policies ORDER BY created_at DESC`)
      .all<any>();
    return rows.results || [];
  }
}
