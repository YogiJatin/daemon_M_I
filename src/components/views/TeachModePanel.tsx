import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';

export const TeachModePanel: React.FC = () => {
  const [isArmed, setIsArmed] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [recipes, setRecipes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const fetchRecipes = async () => {
    try {
      const res = await api.getTeachRecipes();
      setRecipes(res.recipes || []);
    } catch (err: any) {
      console.error('Failed to load teach recipes:', err);
    }
  };

  useEffect(() => {
    fetchRecipes();
  }, []);

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
      // Record a sample final step before compiling for interactive demo
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
      setStatusMessage(`Recipe approved and indexed to Memory OS!`);
      fetchRecipes();
    } catch (err: any) {
      setStatusMessage(`Approval failed: ${err.message}`);
    }
  };

  const handleExportObsidian = async () => {
    try {
      const res = await api.exportObsidianWorkflows();
      setStatusMessage(`Exported ${res.count} approved recipes to Obsidian vault!`);
    } catch (err: any) {
      setStatusMessage(`Obsidian export failed: ${err.message}`);
    }
  };

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
        <button
          onClick={handleExportObsidian}
          className="px-3 py-1.5 text-xs font-medium rounded border border-border hover:bg-muted text-foreground transition-colors"
        >
          Export Obsidian Mirror
        </button>
      </div>

      {statusMessage && (
        <div className="p-3 text-xs rounded bg-muted/60 text-foreground border border-border">
          {statusMessage}
        </div>
      )}

      {/* Recording Control Box */}
      <div className="p-4 rounded-lg border border-border bg-card space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <span
              className={`w-3 h-3 rounded-full ${
                isArmed ? 'bg-red-500 animate-pulse' : 'bg-zinc-400'
              }`}
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
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recipes.map((r) => (
                  <tr key={r.id} className="hover:bg-muted/40">
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
                    <td className="p-3 text-right">
                      {r.status === 'draft' && (
                        <button
                          onClick={() => handleApproveRecipe(r.id)}
                          className="px-2.5 py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:opacity-90"
                        >
                          Approve Skill
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="p-3 text-[11px] text-muted-foreground border-t border-border">
        Approved teach recipes are exported to Obsidian as Markdown, but the Personal AI OS database remains the canonical source of truth for workflow state, versions, and approvals.
      </div>
    </div>
  );
};
