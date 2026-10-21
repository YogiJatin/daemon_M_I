import React, { useState } from 'react';
import { api } from '../../api/client';

export const ExecutionQueuePanel: React.FC = () => {
  const [plans, setPlans] = useState<any[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleApprove = async (planId: string, approvalHash: string) => {
    try {
      await api.approveExecutionPlan(planId, approvalHash);
      setStatusMessage(`Plan '${planId}' approved!`);
      // Update plan in list
      setPlans((prev) =>
        prev.map((p) => (p.id === planId ? { ...p, status: 'approved' } : p))
      );
    } catch (err: any) {
      setStatusMessage(`Approval failed: ${err.message}`);
    }
  };

  const handleExecute = async (planId: string) => {
    try {
      const res = await api.executeExecutionPlan(planId);
      setStatusMessage(`Execution finished with status: ${res.execution?.status}`);
      setPlans((prev) =>
        prev.map((p) => (p.id === planId ? { ...p, status: res.execution?.status } : p))
      );
    } catch (err: any) {
      setStatusMessage(`Execution failed: ${err.message}`);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="border-b border-border pb-4">
        <h2 className="text-xl font-bold tracking-tight text-foreground">Execution Queue & Approvals</h2>
        <p className="text-sm text-muted-foreground">
          Every meaningful desktop or browser action requires explicit owner authorization.
        </p>
      </div>

      {statusMessage && (
        <div className="p-3 text-xs rounded bg-muted/60 text-foreground border border-border">
          {statusMessage}
        </div>
      )}

      {plans.length === 0 ? (
        <div className="p-8 text-center text-xs text-muted-foreground border border-dashed border-border rounded-lg">
          No pending execution proposals. All desktop actions are strictly permission-gated.
        </div>
      ) : (
        <div className="space-y-4">
          {plans.map((p) => (
            <div key={p.id} className="p-4 rounded-lg border border-border bg-card space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">{p.intent}</h4>
                  <span className="text-[11px] text-muted-foreground font-mono">Plan ID: {p.id}</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      p.riskTier === 'tier_1_safe'
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                    }`}
                  >
                    {p.riskTier?.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground">
                    {p.status?.toUpperCase()}
                  </span>
                </div>
              </div>

              {p.approvalHash && (
                <div className="p-2 rounded bg-muted text-[11px] font-mono break-all text-muted-foreground">
                  Payload Hash: {p.approvalHash}
                </div>
              )}

              <div className="flex justify-end space-x-2 pt-2 border-t border-border">
                {p.status === 'pending_approval' && (
                  <button
                    onClick={() => handleApprove(p.id, p.approvalHash)}
                    className="px-3 py-1.5 text-xs font-semibold rounded bg-green-600 text-white hover:bg-green-700"
                  >
                    Confirm & Approve
                  </button>
                )}
                {p.status === 'approved' && (
                  <button
                    onClick={() => handleExecute(p.id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground hover:opacity-90"
                  >
                    Run Execution
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
