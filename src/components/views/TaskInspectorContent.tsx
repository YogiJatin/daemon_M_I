import React, { useState, useEffect } from 'react';
import type { Task } from '../../api/types';
import { api } from '../../api/client';

interface TaskInspectorContentProps {
  task: Task;
  onRefresh: () => void;
  onClose: () => void;
}

export const TaskInspectorContent: React.FC<TaskInspectorContentProps> = ({
  task,
  onRefresh,
  onClose,
}) => {
  const [whyData, setWhyData] = useState<{ audit_trail: any[]; notifications: any[] } | null>(null);
  const [loadingWhy, setLoadingWhy] = useState(false);

  useEffect(() => {
    let isMounted = true;
    setLoadingWhy(true);
    api.getTaskWhy(task.id)
      .then((data) => {
        if (isMounted) setWhyData(data);
      })
      .catch(() => {
        if (isMounted) setWhyData(null);
      })
      .finally(() => {
        if (isMounted) setLoadingWhy(false);
      });
    return () => {
      isMounted = false;
    };
  }, [task.id]);

  const handleComplete = async () => {
    try {
      await api.completeTask(task.id);
      onRefresh();
      onClose();
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    }
  };

  const handleSnooze = async (minutes: number) => {
    try {
      await api.snoozeTask(task.id, minutes);
      onRefresh();
      onClose();
    } catch (err: any) {
      alert(`Snooze failed: ${err.message}`);
    }
  };

  return (
    <div className="space-y-5">
      {/* Vitals */}
      <div className="p-3 rounded-lg bg-surface-container-low space-y-2 border border-surface-container">
        <div className="flex justify-between font-mono text-xs">
          <span className="text-outline">Status:</span>
          <span className="text-on-surface uppercase font-medium">{task.status}</span>
        </div>
        <div className="flex justify-between font-mono text-xs">
          <span className="text-outline">Priority:</span>
          <span className="text-primary uppercase font-medium">{task.priority}</span>
        </div>
        <div className="flex justify-between font-mono text-xs">
          <span className="text-outline">Deadline Version:</span>
          <span className="text-on-surface">v{task.deadline_version}</span>
        </div>
        {task.deadline_local_date && (
          <div className="flex justify-between font-mono text-xs">
            <span className="text-outline">Local Deadline:</span>
            <span className="text-on-surface">{task.deadline_local_date} {task.deadline_time_local || ''}</span>
          </div>
        )}
      </div>

      {/* Description */}
      {task.description && (
        <div>
          <h4 className="font-mono text-xs uppercase text-outline mb-1">Directive Details</h4>
          <p className="font-sans text-xs text-on-surface-variant bg-surface-container-low p-2.5 rounded border border-surface-container leading-relaxed">
            {task.description}
          </p>
        </div>
      )}

      {/* Quick Action buttons */}
      {task.status !== 'completed' && (
        <div className="flex gap-2">
          <button
            onClick={handleComplete}
            className="flex-1 min-h-[44px] py-2 px-3 rounded-lg bg-ok text-on-primary font-mono text-xs font-semibold"
          >
            Mark Done
          </button>
          <button
            onClick={() => handleSnooze(60)}
            className="flex-1 min-h-[44px] py-2 px-3 rounded-lg bg-surface-container hover:bg-surface-container-high border border-surface-container font-mono text-xs text-secondary"
          >
            Snooze 1h
          </button>
        </div>
      )}

      {/* Why Reminded / Provenance Ledger */}
      <div>
        <h4 className="font-mono text-xs uppercase text-outline mb-2 flex items-center justify-between">
          <span>Provenance & Audit Trail</span>
          <span className="text-[10px] text-ok">VERIFIED</span>
        </h4>

        {loadingWhy ? (
          <div className="font-mono text-xs text-outline py-2">Loading provenance...</div>
        ) : whyData ? (
          <div className="space-y-2">
            {whyData.notifications.length > 0 && (
              <div className="p-2.5 rounded bg-surface-container-lowest border border-surface-container text-xs font-mono">
                <div className="text-outline text-[10px] uppercase mb-1">Notification History</div>
                {whyData.notifications.map((n: any, i: number) => (
                  <div key={i} className="flex justify-between py-0.5 text-on-surface-variant">
                    <span>{n.scheduled_at?.slice(11, 16)} IST</span>
                    <span className="text-primary uppercase">{n.status}</span>
                  </div>
                ))}
              </div>
            )}

            {whyData.audit_trail.length > 0 && (
              <div className="p-2.5 rounded bg-surface-container-lowest border border-surface-container text-xs font-mono">
                <div className="text-outline text-[10px] uppercase mb-1">Audit Ledger Mutations</div>
                {whyData.audit_trail.map((a: any, i: number) => (
                  <div key={i} className="py-0.5 border-b border-surface-container/40 last:border-0">
                    <span className="text-primary">{a.event_type}</span>{' '}
                    <span className="text-outline text-[10px]">by {a.actor}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="font-mono text-xs text-outline py-2">No audit entries found.</div>
        )}
      </div>
    </div>
  );
};
