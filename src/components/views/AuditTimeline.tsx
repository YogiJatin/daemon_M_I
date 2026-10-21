import React, { useState, useEffect } from 'react';
import type { AuditEventItem } from '../../api/types';
import { Card } from '../primitives/Card';
import { EmptyState } from '../primitives/EmptyState';
import { api } from '../../api/client';

interface AuditTimelineProps {
  onInspectEvent: (event: AuditEventItem) => void;
}

export const AuditTimeline: React.FC<AuditTimelineProps> = ({ onInspectEvent }) => {
  const [events, setEvents] = useState<AuditEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getHistory({ limit: 40 });
      setEvents(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load timeline');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between pb-4 border-b border-surface-container">
        <div>
          <h2 className="font-sans text-xl font-semibold text-on-surface">Timeline (Audit Ledger)</h2>
          <p className="font-mono text-xs text-outline mt-0.5">
            Tamper-evident, cryptographically chained event stream
          </p>
        </div>
        <button
          onClick={fetchHistory}
          className="min-h-[44px] sm:min-h-[32px] px-3 font-mono text-xs text-outline hover:text-on-surface bg-surface-container-low hover:bg-surface-container rounded-lg border border-surface-container"
        >
          ↻ Refresh
        </button>
      </div>

      <Card title={`Verified Audit Events (${events.length})`}>
        {loading ? (
          <div className="text-center py-16 font-mono text-xs text-primary animate-pulse">
            Verifying cryptographic ledger...
          </div>
        ) : error ? (
          <div className="text-center py-10 font-mono text-xs text-error">
            Error: {error}
          </div>
        ) : events.length === 0 ? (
          <EmptyState title="Audit ledger is empty" description="No events recorded yet." />
        ) : (
          <div className="relative pl-6 border-l border-surface-container space-y-4">
            {events.map((ev, idx) => (
              <div
                key={ev.id || idx}
                onClick={() => onInspectEvent(ev)}
                className="group relative cursor-pointer"
              >
                {/* Dot */}
                <div className="absolute -left-[31px] top-1.5 w-2.5 h-2.5 rounded-full bg-primary border-2 border-surface-container-lowest" />

                <div className="p-3 rounded-lg bg-surface-container-lowest hover:bg-surface-container transition-colors border border-surface-container/60">
                  <div className="flex items-center justify-between font-mono text-xs mb-1">
                    <span className="font-semibold text-primary">{ev.event_type}</span>
                    <span className="text-[10px] text-outline">{ev.created_at}</span>
                  </div>
                  <div className="font-sans text-xs text-on-surface">
                    Actor: <span className="font-mono text-outline">{ev.actor}</span> · Entity:{' '}
                    <span className="font-mono text-outline">{ev.entity_type}:{ev.entity_id}</span>
                  </div>
                  {ev.summary && (
                    <div className="font-sans text-xs text-on-surface-variant mt-1">
                      {ev.summary}
                    </div>
                  )}
                  {ev.record_hash && (
                    <div className="font-mono text-[9px] text-outline-variant truncate mt-1">
                      Hash: {ev.record_hash.slice(0, 24)}...
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
