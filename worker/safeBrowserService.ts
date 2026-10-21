/**
 * worker/safeBrowserService.ts — Safe Browser Launch & Boundary Isolation Service
 *
 * Requirements:
 * - Generates isolated browser launch configurations (disposable profile, no cookies/passwords)
 * - Enforces BrowserPolicy rules
 * - Emits SAFE_BROWSER_OPENED and BROWSER_POLICY_APPLIED audit events
 */

import { BrowserPolicyEngine, BrowserPolicyEvaluation } from './browserPolicy';
import { AuditService } from './auditService';

export interface SafeBrowserLaunchPlan {
  url: string;
  policy: BrowserPolicyEvaluation;
  command: string;
  arguments: string[];
  userDataDir: string | null;
  flags: {
    incognito: boolean;
    disableNotifications: boolean;
    isolatedProfile: boolean;
  };
  allowed: boolean;
  auditId?: string;
}

export class SafeBrowserService {
  /**
   * Evaluates policy and prepares a deterministic launch plan.
   */
  static async prepareLaunch(
    db: D1Database,
    targetUrl: string,
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<SafeBrowserLaunchPlan> {
    const policy = await BrowserPolicyEngine.evaluate(db, targetUrl);

    // Audit policy evaluation
    await AuditService.emit(
      db,
      {
        eventType: 'BROWSER_POLICY_APPLIED',
        entityType: 'browser_policy',
        entityId: policy.domain,
        actor: 'system:policy_engine',
        payload: {
          url: targetUrl,
          domain: policy.domain,
          policy: policy.policy,
          isolationLevel: policy.isolationLevel,
        },
        metadata: { domain: policy.domain },
      },
      env
    );

    if (policy.isBlocked) {
      return {
        url: targetUrl,
        policy,
        command: '',
        arguments: [],
        userDataDir: null,
        flags: { incognito: true, disableNotifications: true, isolatedProfile: true },
        allowed: false,
      };
    }

    // Determine sandbox arguments based on isolation level
    let userDataDir: string | null = null;
    const args: string[] = [];
    const isIncognito = policy.isolationLevel !== 'standard';

    if (policy.isolationLevel === 'disposable_sandbox') {
      userDataDir = `%TEMP%\\personal_ai_os_sandbox_${crypto.randomUUID().slice(0, 8)}`;
      args.push(`--user-data-dir="${userDataDir}"`);
      args.push('--no-first-run');
      args.push('--no-default-browser-check');
      args.push('--disable-notifications');
      args.push('--incognito');
      args.push(targetUrl);
    } else if (policy.isolationLevel === 'incognito_profile') {
      args.push('--incognito');
      args.push('--disable-notifications');
      args.push(targetUrl);
    } else {
      args.push(targetUrl);
    }

    // Emit safe browser opened audit
    await AuditService.emit(
      db,
      {
        eventType: 'SAFE_BROWSER_OPENED',
        entityType: 'browser_session',
        entityId: policy.domain,
        actor: 'owner',
        payload: {
          url: targetUrl,
          isolationLevel: policy.isolationLevel,
          userDataDir,
        },
        metadata: { domain: policy.domain },
      },
      env
    );

    return {
      url: targetUrl,
      policy,
      command: 'chrome.exe',
      arguments: args,
      userDataDir,
      flags: {
        incognito: isIncognito,
        disableNotifications: policy.isolationLevel !== 'standard',
        isolatedProfile: policy.isolationLevel === 'disposable_sandbox',
      },
      allowed: true,
    };
  }
}
