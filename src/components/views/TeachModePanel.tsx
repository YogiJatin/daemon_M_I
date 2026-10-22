import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import { checkAgentHealth, writeToObsidian } from '../../api/desktopAgentClient';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RecipeExportState {
  status: 'idle' | 'loading' | 'success' | 'error' | 'fallback';
  message: string | null;
  relativePath: string | null;
  markdown: string | null; // filled on error so Copy Markdown fallback works
}

// ─── Component ────────────────────────────────────────────────────────────────

export const TeachModePanel: React.FC = () => {
  const [isArmed, setIsArmed] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [recipes, setRecipes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Per-recipe export state keyed by recipe ID
  const [exportStates, setExportStates] = useState<Record<string, RecipeExportState>>({});

  // Whether the desktop agent is reachable (checked once on mount, re-checked before write)
  const [agentAvailable, setAgentAvailable] = useState<boolean | null>(null);

  // ── Data loading ───────────────────────────────────────────────────────────

  const fetchRecipes = useCallback(async () => {
    try {
      const res = await api.getTeachRecipes();
      setRecipes(res.recipes || []);
    } catch (err: any) {
      console.error('Failed to load teach recipes:', err);
    }
  }, []);

  useEffect(() => {
    fetchRecipes();
    // Probe agent health once on mount
    checkAgentHealth().then((h) => setAgentAvailable(h?.ok ?? false));
  }, [fetchRecipes]);

  // ── Teach Mode controls ────────────────────────────────────────────────────

  const handleStartSession = async () => {
    if (!sessionTitle.trim()) {
      setStatusMessage('Please enter a session title.');
      return;
    }
    setLoading(true);
    setStatusMessage(null);
    try {
      const res = await api.startTeachSession(sessionTitle.trim(), 'browser:desktop');
      setActiveSessionId(res.session.id);
      setIsArmed(true);
      setStatusMessage(`Teach Mode armed! Recording session: ${res.session.id}`);
    } catch (err: any) {
      setStatusMessage(`Failed to start: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCompileSession = async () => {
    if (!activeSessionId) return;
    setLoading(true);
    try {
      await api.recordTeachStep(
        activeSessionId,
        'app_launch',
        `Completed demonstration: ${sessionTitle}`,
        'desktop:shell'
      );
      const res = await api.compileTeachSession(activeSessionId, sessionTitle, `Workflow to ${sessionTitle}`);
      setIsArmed(false);
      setActiveSessionId(null);
      setSessionTitle('');
      setStatusMessage(`Compiled recipe: ${res.recipe.recipeId} (Status: Draft)`);
      fetchRecipes();
    } catch (err: any) {
      setStatusMessage(`Compilation error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleApproveRecipe = async (recipeId: string) => {
    try {
      await api.approveTeachRecipe(recipeId);
      setStatusMessage('Recipe approved and indexed to Memory OS!');
      fetchRecipes();
    } catch (err: any) {
      setStatusMessage(`Approval failed: ${err.message}`);
    }
  };

  // ── Per-recipe Obsidian export ──────────────────────────────────────────────

  const setRecipeExportState = (recipeId: string, update: Partial<RecipeExportState>) => {
    setExportStates((prev) => {
      const existing = prev[recipeId] ?? {
        status: 'idle',
        message: null,
        relativePath: null,
        markdown: null,
      };
      return {
        ...prev,
        [recipeId]: {
          ...existing,
          ...update,
        },
      };
    });
  };

  const handleExportRecipeToObsidian = async (recipe: any) => {
    const recipeId = recipe.id;

    // Re-probe agent health before committing to the write path
    setRecipeExportState(recipeId, { status: 'loading', message: 'Connecting to desktop agent…', relativePath: null, markdown: null });

    const health = await checkAgentHealth();
    if (!health?.ok) {
      setAgentAvailable(false);
      // Fetch the markdown so the fallback Copy button has something to copy
      let fallbackMarkdown: string | null = null;
      try {
        const payload = await api.getObsidianWorkflows();
        const note = payload.workflows.find((n: any) => n.recipeId === recipeId);
        fallbackMarkdown = note?.markdown ?? null;
      } catch { /* non-critical */ }

      setRecipeExportState(recipeId, {
        status: 'fallback',
        message: 'Desktop agent is not running.',
        relativePath: null,
        markdown: fallbackMarkdown,
      });
      return;
    }

    setAgentAvailable(true);

    // Fetch the Markdown payload from the cloud
    let markdown: string;
    let filename: string;
    let folder: string;
    try {
      const payload = await api.getObsidianWorkflows();
      const note = payload.workflows.find((n: any) => n.recipeId === recipeId);
      if (!note) {
        setRecipeExportState(recipeId, { status: 'error', message: 'Recipe not found in Obsidian payload — is it approved?', relativePath: null, markdown: null });
        return;
      }
      markdown = note.markdown;
      filename = note.filename;
      // vaultPath is like "Workflows/My Recipe.md" — split into folder + filename
      const parts = note.vaultPath?.split('/') ?? ['Workflows', note.filename];
      folder   = parts.slice(0, -1).join('/') || 'Workflows';
    } catch (err: any) {
      setRecipeExportState(recipeId, { status: 'error', message: `Failed to fetch recipe: ${err.message}`, relativePath: null, markdown: null });
      return;
    }

    // Write via desktop agent (nonce fetched inside writeToObsidian)
    const result = await writeToObsidian({ folder, filename, content: markdown });

    if (result.success) {
      setRecipeExportState(recipeId, {
        status:       'success',
        message:      `Exported to Obsidian`,
        relativePath: result.relativePath ?? null,
        markdown:     null,
      });
    } else {
      setRecipeExportState(recipeId, {
        status:   'error',
        message:  result.error ?? 'Unknown error from desktop agent.',
        relativePath: null,
        markdown, // keep for fallback copy
      });
    }
  };

  // ── Bulk "Export Obsidian Mirror" (top-right, exports all approved at once) ─

  const handleExportAllObsidian = async () => {
    const approvedRecipes = recipes.filter((r) => r.status === 'approved');
    if (approvedRecipes.length === 0) {
      setStatusMessage('No approved recipes to export.');
      return;
    }

    const health = await checkAgentHealth();
    if (!health?.ok) {
      setAgentAvailable(false);
      setStatusMessage('Desktop agent not running. Start it with: npx tsx desktop-agent/obsidian-writer.ts');
      return;
    }

    setStatusMessage(`Exporting ${approvedRecipes.length} recipe(s) to Obsidian…`);
    let ok = 0; let fail = 0;
    for (const r of approvedRecipes) {
      await handleExportRecipeToObsidian(r);
      const st = exportStates[r.id];
      if (st?.status === 'success') ok++; else fail++;
    }
    setStatusMessage(`Export complete: ${ok} written, ${fail} failed.`);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">Teach Mode (Workflow Learning)</h2>
          <p className="text-sm text-muted-foreground">
            Observe → Trace → Graph → Recipe → Approval → Skill
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Agent status indicator */}
          {agentAvailable !== null && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                agentAvailable
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
              }`}
            >
              {agentAvailable ? 'Agent ●' : 'Agent ○ offline'}
            </span>
          )}
          <button
            onClick={handleExportAllObsidian}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border hover:bg-muted text-foreground transition-colors"
          >
            Export All to Obsidian
          </button>
        </div>
      </div>

      {/* Global status message */}
      {statusMessage && (
        <div className="p-3 text-xs rounded bg-muted/60 text-foreground border border-border">
          {statusMessage}
        </div>
      )}

      {/* Agent offline banner */}
      {agentAvailable === false && (
        <div className="p-3 text-xs rounded bg-yellow-50 text-yellow-900 border border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-800">
          <span className="font-semibold">Desktop Agent offline.</span>{' '}
          Start it to enable direct Obsidian export:
          <code className="ml-2 font-mono bg-yellow-100 dark:bg-yellow-900/40 px-1 rounded">
            npx tsx desktop-agent/obsidian-writer.ts
          </code>
        </div>
      )}

      {/* Recording Control Box */}
      <div className="p-4 rounded-lg border border-border bg-card space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span
              className={`w-3 h-3 rounded-full ${isArmed ? 'bg-red-500 animate-pulse' : 'bg-zinc-400'}`}
            />
            <span className="font-medium text-sm text-foreground">
              {isArmed ? 'RECORDING WORKFLOW' : 'TEACH MODE DISARMED'}
            </span>
          </div>
          {isArmed ? (
            <button
              onClick={handleCompileSession}
              disabled={loading}
              className="px-4 py-1.5 text-xs font-semibold rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
            >
              Compile to Recipe
            </button>
          ) : (
            <div className="flex items-center space-x-2">
              <input
                type="text"
                placeholder="Workflow name (e.g. Export Midterm Grades)"
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
                className="px-3 py-1.5 text-xs rounded border border-border bg-background text-foreground w-64"
              />
              <button
                onClick={handleStartSession}
                disabled={loading}
                className="px-4 py-1.5 text-xs font-semibold rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                Arm & Record
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Workflow Recipes Table */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Workflow Recipes & Learned Skills</h3>
        {recipes.length === 0 ? (
          <p className="text-xs text-muted-foreground">No workflow recipes compiled yet.</p>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted text-muted-foreground border-b border-border">
                <tr>
                  <th className="p-3">Title</th>
                  <th className="p-3">Steps</th>
                  <th className="p-3">Confidence</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recipes.map((r) => {
                  const exp = exportStates[r.id];
                  return (
                    <React.Fragment key={r.id}>
                      <tr className="hover:bg-muted/40">
                        <td className="p-3 font-medium text-foreground">{r.title}</td>
                        <td className="p-3 text-muted-foreground">{r.steps?.length || 0} steps</td>
                        <td className="p-3 text-muted-foreground">
                          {Math.round((r.confidence || 1) * 100)}%
                        </td>
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              r.status === 'approved'
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                                : r.status === 'draft'
                                ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300'
                                : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300'
                            }`}
                          >
                            {r.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="p-3 text-right space-x-2">
                          {r.status === 'draft' && (
                            <button
                              onClick={() => handleApproveRecipe(r.id)}
                              className="px-2.5 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:opacity-90"
                            >
                              Approve Skill
                            </button>
                          )}
                          {r.status === 'approved' && (
                            <button
                              onClick={() => handleExportRecipeToObsidian(r)}
                              disabled={exp?.status === 'loading'}
                              className="px-2.5 py-1 text-xs font-medium rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
                            >
                              {exp?.status === 'loading' ? 'Exporting…' : 'Export to Obsidian'}
                            </button>
                          )}
                        </td>
                      </tr>

                      {/* Per-recipe export result row */}
                      {exp && exp.status !== 'idle' && (
                        <tr className="bg-muted/20">
                          <td colSpan={5} className="px-3 pb-2 pt-1">
                            {exp.status === 'success' && (
                              <span className="text-[11px] text-green-700 dark:text-green-400">
                                ✓ {exp.message}
                                {exp.relativePath && (
                                  <span className="ml-1 font-mono opacity-80">{exp.relativePath}</span>
                                )}
                              </span>
                            )}
                            {exp.status === 'error' && (
                              <span className="text-[11px] text-red-700 dark:text-red-400 flex items-center gap-3">
                                ✗ {exp.message}
                                {exp.markdown && (
                                  <button
                                    onClick={() => navigator.clipboard.writeText(exp.markdown!)}
                                    className="px-2 py-0.5 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-[10px]"
                                  >
                                    Copy Markdown
                                  </button>
                                )}
                              </span>
                            )}
                            {exp.status === 'fallback' && (
                              <span className="text-[11px] text-yellow-700 dark:text-yellow-400 flex items-center gap-3">
                                ⚠ {exp.message}
                                {exp.markdown && (
                                  <button
                                    onClick={() => navigator.clipboard.writeText(exp.markdown!)}
                                    className="px-2 py-0.5 rounded border border-yellow-400 dark:border-yellow-600 text-yellow-800 dark:text-yellow-300 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 transition-colors text-[10px]"
                                  >
                                    Copy Markdown
                                  </button>
                                )}
                                <span className="opacity-70">
                                  Start agent:{' '}
                                  <code className="font-mono">npx tsx desktop-agent/obsidian-writer.ts</code>
                                </span>
                              </span>
                            )}
                            {exp.status === 'loading' && (
                              <span className="text-[11px] text-muted-foreground animate-pulse">
                                {exp.message}
                              </span>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="p-3 text-[11px] text-muted-foreground border-t border-border">
        Approved teach recipes are exported to Obsidian as Markdown, but the Personal AI OS
        database remains the canonical source of truth for workflow state, versions, and approvals.
        The desktop agent never exposes vault contents — it only writes.
      </div>
    </div>
  );
};
