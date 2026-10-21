import React, { useState } from 'react';
import { api } from '../../api/client';

export const SafeBrowserPanel: React.FC = () => {
  const [targetUrl, setTargetUrl] = useState('');
  const [evaluation, setEvaluation] = useState<any>(null);
  const [launchPlan, setLaunchPlan] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckUrl = async () => {
    if (!targetUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.observeBrowserUrl(targetUrl.trim());
      setEvaluation(res.evaluation);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLaunchSafeBrowser = async () => {
    if (!targetUrl.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.openSafeBrowser(targetUrl.trim());
      setLaunchPlan(res.launchPlan);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="border-b border-border pb-4">
        <h2 className="text-xl font-bold tracking-tight text-foreground">Safe Browser Mode</h2>
        <p className="text-sm text-muted-foreground">
          Isolate risky, streaming, or untrusted pages in sandboxed browser boundaries with zero shared cookies.
        </p>
      </div>

      {error && <div className="p-3 text-xs rounded bg-destructive/15 text-destructive">{error}</div>}

      {/* URL Evaluation Input */}
      <div className="p-4 rounded-lg border border-border bg-card space-y-3">
        <label className="text-xs font-semibold text-foreground">Target Destination URL</label>
        <div className="flex space-x-2">
          <input
            type="text"
            placeholder="https://example-mirror.stream/watch"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            className="flex-1 px-3 py-1.5 text-xs rounded border border-border bg-background text-foreground"
          />
          <button
            onClick={handleCheckUrl}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border hover:bg-muted text-foreground"
          >
            Check Policy
          </button>
          <button
            onClick={handleLaunchSafeBrowser}
            disabled={loading}
            className="px-4 py-1.5 text-xs font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            Launch in Safe Browser
          </button>
        </div>
      </div>

      {/* Policy Evaluation Result */}
      {evaluation && (
        <div className="p-4 rounded-lg border border-border bg-muted/40 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-foreground">Policy Classification</span>
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                evaluation.policy === 'trusted'
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                  : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300'
              }`}
            >
              {evaluation.policy.toUpperCase()}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div><strong>Domain:</strong> {evaluation.domain}</div>
            <div><strong>Isolation Level:</strong> {evaluation.isolationLevel}</div>
          </div>
          <p className="text-xs text-foreground font-mono bg-background p-2 rounded border border-border">
            {evaluation.reason}
          </p>
        </div>
      )}

      {/* Launch Plan Arguments */}
      {launchPlan && (
        <div className="p-4 rounded-lg border border-border bg-card space-y-2">
          <h4 className="text-xs font-bold text-foreground">Sandbox Launch Configuration</h4>
          <pre className="p-3 bg-muted rounded text-[11px] font-mono overflow-x-auto text-foreground">
            {launchPlan.command} {launchPlan.arguments?.join(' ')}
          </pre>
          <div className="flex space-x-4 text-[11px] text-muted-foreground">
            <span>Incognito: {launchPlan.flags?.incognito ? 'Yes' : 'No'}</span>
            <span>Notifications: {launchPlan.flags?.disableNotifications ? 'Blocked' : 'Allowed'}</span>
            <span>Isolated Profile: {launchPlan.flags?.isolatedProfile ? 'Active' : 'Standard'}</span>
          </div>
        </div>
      )}
    </div>
  );
};
