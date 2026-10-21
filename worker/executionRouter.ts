/**
 * worker/executionRouter.ts — Step Dispatcher to Typed Adapters
 *
 * Requirements:
 * - Directs execution steps to their respective typed adapters
 * - Records step execution outcomes and timing
 */

import {
  ExecutionPlanRecord,
  ExecutionStepDefinition,
  StepExecutionResult,
} from './executionTypes';
import { DesktopAdapter } from './providers/desktop/desktopAdapter';
import { BrowserAdapter } from './providers/browser/browserAdapter';
import { FilesystemAdapter } from './providers/filesystem/filesystemAdapter';
import { TerminalAdapter } from './providers/terminal/terminalAdapter';

export class ExecutionRouter {
  /**
   * Dispatches an individual execution step to its adapter.
   */
  static async dispatchStep(
    step: ExecutionStepDefinition,
    env: Record<string, any> = {}
  ): Promise<StepExecutionResult> {
    const start = Date.now();

    try {
      let output: any = null;

      switch (step.adapter) {
        case 'desktop': {
          if (step.action === 'launch_app') {
            output = await DesktopAdapter.launchApp(step.parameters.app || step.parameters.target);
          } else if (step.action === 'media_key') {
            output = await DesktopAdapter.sendMediaKey(step.parameters.key);
          } else {
            throw new Error(`Unsupported desktop action '${step.action}'.`);
          }
          break;
        }

        case 'browser': {
          if (step.action === 'navigate') {
            output = await BrowserAdapter.navigate(step.parameters.url);
          } else if (step.action === 'click') {
            output = await BrowserAdapter.clickSelector(step.parameters.selector);
          } else if (step.action === 'extract') {
            output = await BrowserAdapter.extractText(step.parameters.selector);
          } else {
            throw new Error(`Unsupported browser action '${step.action}'.`);
          }
          break;
        }

        case 'filesystem': {
          if (step.action === 'copy_file') {
            output = await FilesystemAdapter.copyFile(step.parameters.source, step.parameters.destination);
          } else if (step.action === 'list_directory') {
            output = await FilesystemAdapter.listDirectory(step.parameters.path);
          } else {
            throw new Error(`Unsupported filesystem action '${step.action}'.`);
          }
          break;
        }

        case 'terminal': {
          if (step.action === 'run_command') {
            output = await TerminalAdapter.executeCommand(step.parameters.commandKey);
          } else {
            throw new Error(`Unsupported terminal action '${step.action}'.`);
          }
          break;
        }

        case 'clipboard': {
          output = { success: true, text: step.parameters.text || '' };
          break;
        }

        case 'window': {
          output = { success: true, windowTitle: step.parameters.title || '' };
          break;
        }

        default:
          throw new Error(`Unknown adapter type '${step.adapter}'.`);
      }

      return {
        stepIndex: step.stepIndex,
        success: true,
        output,
        durationMs: Date.now() - start,
        rollbackAvailable: Boolean(step.rollbackAction),
      };
    } catch (err: any) {
      return {
        stepIndex: step.stepIndex,
        success: false,
        error: err.message || 'Step execution failed.',
        durationMs: Date.now() - start,
        rollbackAvailable: Boolean(step.rollbackAction),
      };
    }
  }

  /**
   * Dispatches all steps of an execution plan sequentially.
   */
  static async dispatchPlan(
    db: D1Database,
    plan: ExecutionPlanRecord,
    env: Record<string, any> = {}
  ): Promise<StepExecutionResult[]> {
    const results: StepExecutionResult[] = [];

    for (const step of plan.steps) {
      // Mark step running
      await db
        .prepare(`UPDATE execution_steps SET status = 'running' WHERE plan_id = ? AND step_index = ?`)
        .bind(plan.id, step.stepIndex)
        .run();

      const result = await this.dispatchStep(step, env);
      results.push(result);

      // Update step status in database
      const status = result.success ? 'success' : 'failed';
      await db
        .prepare(`UPDATE execution_steps SET status = ?, error = ? WHERE plan_id = ? AND step_index = ?`)
        .bind(status, result.error || null, plan.id, step.stepIndex)
        .run();

      // If a step fails, halt execution sequence
      if (!result.success) {
        break;
      }
    }

    return results;
  }
}
