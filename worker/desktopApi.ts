/**
 * worker/desktopApi.ts — Desktop Intelligence, Teach Mode, Safe Browser & Obsidian API Router
 *
 * Exposes:
 * - /api/v1/teach/*
 * - /api/v1/browser/*
 * - /api/v1/camera/*
 * - /api/v1/execution/*
 * - /api/v1/obsidian/*
 */

import { TeachModeController } from './teachMode';
import { TeachRecorder } from './teachRecorder';
import { TeachCompiler } from './teachCompiler';
import { TeachRecipeService } from './teachRecipeService';
import { BrowserPolicyEngine } from './browserPolicy';
import { SafeBrowserService } from './safeBrowserService';
import { CameraIngressService } from './cameraIngress';
import { MockCameraProvider, CameraCaptureMode } from './cameraProvider';
import { ExecutionPlanner } from './executionPlanner';
import { ExecutionService } from './executionService';
import { ObsidianExportService } from './obsidianExport';

export async function handleDesktopApi(
  request: Request,
  env: Record<string, any>,
  now: Date = new Date()
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const isDesktopRoute =
    path.startsWith('/api/v1/teach') ||
    path.startsWith('/api/v1/browser') ||
    path.startsWith('/api/v1/camera') ||
    path.startsWith('/api/v1/execution') ||
    path.startsWith('/api/v1/obsidian');

  if (!isDesktopRoute) {
    return null;
  }

  const jsonSuccess = (data: any, status: number = 200) =>
    Response.json({ ok: true, data }, { status });
  const jsonError = (code: string, message: string, status: number = 400) =>
    Response.json({ ok: false, error: { code, message } }, { status });

  try {
    // =========================================================================
    // 1. TEACH MODE ENDPOINTS
    // =========================================================================

    // POST /api/v1/teach/start
    if (method === 'POST' && path === '/api/v1/teach/start') {
      const body = await request.json<any>().catch(() => ({}));
      if (!body.title) {
        return jsonError('bad_request', "Missing 'title' for teach session.", 400);
      }
      const session = await TeachModeController.startSession(
        env.DB,
        {
          title: body.title,
          appContext: body.appContext || body.app_context,
          metadata: body.metadata,
        },
        env,
        now
      );
      return jsonSuccess({ session }, 201);
    }

    // POST /api/v1/teach/step
    if (method === 'POST' && path === '/api/v1/teach/step') {
      const body = await request.json<any>().catch(() => ({}));
      const sessionId = body.sessionId || body.session_id;
      const actionType = body.actionType || body.action_type;
      const intentSummary = body.intentSummary || body.intent_summary;

      if (!sessionId || !actionType || !intentSummary) {
        return jsonError('bad_request', "Missing 'sessionId', 'actionType', or 'intentSummary'.", 400);
      }

      const step = await TeachRecorder.recordStep(
        env.DB,
        {
          sessionId,
          actionType,
          intentSummary,
          targetSelector: body.targetSelector || body.target_selector,
          rawInput: body.rawInput || body.raw_input,
        },
        env,
        now
      );
      return jsonSuccess({ step }, 201);
    }

    // POST /api/v1/teach/compile
    if (method === 'POST' && path === '/api/v1/teach/compile') {
      const body = await request.json<any>().catch(() => ({}));
      const sessionId = body.sessionId || body.session_id;
      if (!sessionId) {
        return jsonError('bad_request', "Missing 'sessionId' to compile.", 400);
      }

      const recipe = await TeachCompiler.compileSession(
        env.DB,
        sessionId,
        {
          title: body.title,
          intent: body.intent,
          triggerType: body.triggerType || body.trigger_type,
        },
        env,
        now
      );
      return jsonSuccess({ recipe }, 201);
    }

    // POST /api/v1/teach/:id/approve
    if (method === 'POST' && path.match(/^\/api\/v1\/teach\/[^/]+\/approve$/)) {
      const recipeId = path.split('/')[4];
      const recipe = await TeachRecipeService.approveRecipe(env.DB, recipeId, env, now);
      return jsonSuccess({ recipe, approved: true });
    }

    // POST /api/v1/teach/:id/reject
    if (method === 'POST' && path.match(/^\/api\/v1\/teach\/[^/]+\/reject$/)) {
      const recipeId = path.split('/')[4];
      const body = await request.json<any>().catch(() => ({}));
      const success = await TeachRecipeService.rejectRecipe(env.DB, recipeId, body.reason, now);
      return jsonSuccess({ rejected: success });
    }

    // GET /api/v1/teach/sessions
    if (method === 'GET' && path === '/api/v1/teach/sessions') {
      const status = url.searchParams.get('status') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const sessions = await TeachModeController.listSessions(env.DB, status, limit);
      return jsonSuccess({ sessions, count: sessions.length });
    }

    // GET /api/v1/teach/recipes
    if (method === 'GET' && path === '/api/v1/teach/recipes') {
      const status = url.searchParams.get('status') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const recipes = await TeachRecipeService.listRecipes(env.DB, status, limit);
      return jsonSuccess({ recipes, count: recipes.length });
    }

    // GET /api/v1/teach/recipes/:id
    if (method === 'GET' && path.match(/^\/api\/v1\/teach\/recipes\/[^/]+$/)) {
      const recipeId = path.replace('/api/v1/teach/recipes/', '');
      const recipe = await TeachRecipeService.getRecipe(env.DB, recipeId);
      if (!recipe) {
        return jsonError('not_found', `Recipe '${recipeId}' not found.`, 404);
      }
      return jsonSuccess({ recipe });
    }

    // =========================================================================
    // 2. SAFE BROWSER ENDPOINTS
    // =========================================================================

    // POST /api/v1/browser/open
    if (method === 'POST' && path === '/api/v1/browser/open') {
      const body = await request.json<any>().catch(() => ({}));
      if (!body.url) {
        return jsonError('bad_request', "Missing 'url' parameter.", 400);
      }

      const launchPlan = await SafeBrowserService.prepareLaunch(env.DB, body.url, env, now);
      return jsonSuccess({ launchPlan, allowed: launchPlan.allowed });
    }

    // POST /api/v1/browser/policy
    if (method === 'POST' && path === '/api/v1/browser/policy') {
      const body = await request.json<any>().catch(() => ({}));
      if (!body.pattern || !body.policy) {
        return jsonError('bad_request', "Missing 'pattern' or 'policy'.", 400);
      }

      await BrowserPolicyEngine.setPolicy(
        env.DB,
        {
          pattern: body.pattern,
          policy: body.policy,
          isolationLevel: body.isolationLevel || body.isolation_level,
          reason: body.reason,
        },
        now
      );
      return jsonSuccess({ message: 'Policy rule updated.' }, 201);
    }

    // POST /api/v1/browser/observe
    if (method === 'POST' && path === '/api/v1/browser/observe') {
      const body = await request.json<any>().catch(() => ({}));
      const evalResult = await BrowserPolicyEngine.evaluate(env.DB, body.url || '');
      return jsonSuccess({ evaluation: evalResult });
    }

    // GET /api/v1/browser/policies
    if (method === 'GET' && path === '/api/v1/browser/policies') {
      const policies = await BrowserPolicyEngine.listPolicies(env.DB);
      return jsonSuccess({ policies, count: policies.length });
    }

    // =========================================================================
    // 3. CAMERA CAPTURE ENDPOINT
    // =========================================================================

    // POST /api/v1/camera/capture
    if (method === 'POST' && path === '/api/v1/camera/capture') {
      const body = await request.json<any>().catch(() => ({}));
      const mode = (body.mode || 'still') as CameraCaptureMode;
      const permissionGranted = body.permission !== false; // Permission gate check

      const provider = new MockCameraProvider(permissionGranted);
      const result = await CameraIngressService.captureAndIngest(
        env.DB,
        provider,
        mode,
        {
          candidateTitle: body.title,
          deviceInfo: body.deviceInfo || body.device_info,
        },
        env,
        now
      );

      return jsonSuccess({ capture: result }, 201);
    }

    // =========================================================================
    // 4. EXECUTION LAYER ENDPOINTS
    // =========================================================================

    // POST /api/v1/execution/plan
    if (method === 'POST' && path === '/api/v1/execution/plan') {
      const body = await request.json<any>().catch(() => ({}));
      if (!body.intent || !Array.isArray(body.steps)) {
        return jsonError('bad_request', "Missing 'intent' or 'steps' array.", 400);
      }

      const plan = await ExecutionPlanner.createPlan(
        env.DB,
        {
          intent: body.intent,
          steps: body.steps,
        },
        env,
        now
      );
      return jsonSuccess({ plan }, 201);
    }

    // POST /api/v1/execution/:id/approve
    if (method === 'POST' && path.match(/^\/api\/v1\/execution\/[^/]+\/approve$/)) {
      const planId = path.split('/')[4];
      const body = await request.json<any>().catch(() => ({}));
      const approvalHash = body.approvalHash || body.approval_hash;

      if (!approvalHash) {
        return jsonError('bad_request', "Missing 'approvalHash' binding.", 400);
      }

      const plan = await ExecutionService.approvePlan(env.DB, planId, approvalHash, env, now);
      return jsonSuccess({ plan, approved: true });
    }

    // POST /api/v1/execution/:id/reject
    if (method === 'POST' && path.match(/^\/api\/v1\/execution\/[^/]+\/reject$/)) {
      const planId = path.split('/')[4];
      const success = await ExecutionService.rejectPlan(env.DB, planId, now);
      return jsonSuccess({ rejected: success });
    }

    // POST /api/v1/execution/:id/execute
    if (method === 'POST' && path.match(/^\/api\/v1\/execution\/[^/]+\/execute$/)) {
      const planId = path.split('/')[4];
      const executionResult = await ExecutionService.executePlan(env.DB, planId, env, now);
      return jsonSuccess({ execution: executionResult });
    }

    // GET /api/v1/execution/:id
    if (method === 'GET' && path.match(/^\/api\/v1\/execution\/[^/]+$/)) {
      const planId = path.replace('/api/v1/execution/', '');
      const plan = await ExecutionService.getPlan(env.DB, planId);
      if (!plan) {
        return jsonError('not_found', `Execution plan '${planId}' not found.`, 404);
      }
      return jsonSuccess({ plan });
    }

    // =========================================================================
    // 5. OBSIDIAN MIRROR ENDPOINTS
    // =========================================================================

    // POST /api/v1/obsidian/export
    if (method === 'POST' && path === '/api/v1/obsidian/export') {
      const body = await request.json<any>().catch(() => ({}));
      const vaultName = body.vaultName || body.vault_name || 'Personal_AI_OS_Vault';
      const exportPayload = await ObsidianExportService.exportAllWorkflows(env.DB, vaultName);
      return jsonSuccess(exportPayload);
    }

    // GET /api/v1/obsidian/workflows
    if (method === 'GET' && path === '/api/v1/obsidian/workflows') {
      const exportPayload = await ObsidianExportService.exportAllWorkflows(env.DB);
      return jsonSuccess({
        workflows: exportPayload.notes,
        count: exportPayload.count,
        canonicalNotice:
          'Approved teach recipes are exported to Obsidian as Markdown, but the Personal AI OS database remains the canonical source of truth for workflow state, versions, and approvals.',
      });
    }

    return null;
  } catch (err: any) {
    return jsonError('server_error', err.message || 'Desktop API request failed.', 500);
  }
}
