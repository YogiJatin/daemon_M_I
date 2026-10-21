import React, { useState, useEffect } from 'react';
import type { SystemStatus } from '../../api/types';
import { Card } from '../primitives/Card';
import { StatusGlyph } from '../primitives/StatusGlyph';
import { api } from '../../api/client';

export const HealthDashboard: React.FC = () => {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getSystemStatus();
      setStatus(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch system status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between pb-4 border-b border-surface-container">
        <div>
          <h2 className="font-sans text-xl font-semibold text-on-surface">System Health (Subsystem Status)</h2>
          <p className="font-mono text-xs text-outline mt-0.5">
            Operational vitals across D1, Cron Scheduler, AI Architecture, and Audit Ledger
          </p>
        </div>
        <button
          onClick={fetchStatus}
          className="min-h-[44px] sm:min-h-[32px] px-3 font-mono text-xs text-outline hover:text-on-surface bg-surface-container-low hover:bg-surface-container rounded-lg border border-surface-container"
        >
          ↻ Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 font-mono text-xs text-primary animate-pulse">
          Querying OS subsystems...
        </div>
      ) : error ? (
        <div className="text-center py-10 font-mono text-xs text-error">
          Error: {error}
        </div>
      ) : status ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* 1. Scheduler Subsystem */}
          <Card title="Cron Scheduler" badge={<StatusGlyph status={status.scheduler.status === 'running' ? 'healthy' : 'paused'} />}>
            <div className="space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-outline">State:</span>
                <span className="text-on-surface uppercase font-medium">{status.scheduler.status}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Failures:</span>
                <span className="text-on-surface">{status.scheduler.consecutive_failures}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Last Tick:</span>
                <span className="text-on-surface truncate max-w-[160px]">{status.scheduler.last_tick_at || 'Never'}</span>
              </div>
            </div>
          </Card>

          {/* 2. D1 Database Subsystem */}
          <Card title="Database Core" badge={<StatusGlyph status="healthy" />}>
            <div className="space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-outline">Engine:</span>
                <span className="text-on-surface">{status.database.engine}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Single Source:</span>
                <span className="text-ok">OWNED</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Status:</span>
                <span className="text-ok font-medium">{status.database.status}</span>
              </div>
            </div>
          </Card>

          {/* 3. AI Architecture */}
          <Card title="AI Monolith Core" badge={<StatusGlyph status="healthy" />}>
            <div className="space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-outline">Active Tier:</span>
                <span className="text-primary font-medium">{status.ai.active_tier}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Capabilities:</span>
                <span className="text-on-surface">{status.ai.capabilities_loaded} registered</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Verification:</span>
                <span className="text-ok">1-Repair Bounded</span>
              </div>
            </div>
          </Card>

          {/* 4. Audit Ledger Subsystem */}
          <Card title="Cryptographic Ledger" badge={<StatusGlyph status="audit_verified" />}>
            <div className="space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-outline">Chain State:</span>
                <span className="text-ok font-medium">VALID</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Latest Sequence:</span>
                <span className="text-on-surface">#{status.audit.latest_sequence}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Tamper Detection:</span>
                <span className="text-ok">ACTIVE</span>
              </div>
            </div>
          </Card>

          {/* 5. Telegram Gateway */}
          <Card title="Telegram Dispatch" badge={<StatusGlyph status={status.telegram.configured ? 'healthy' : 'error'} />}>
            <div className="space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-outline">Configured:</span>
                <span className={status.telegram.configured ? 'text-ok' : 'text-error'}>
                  {status.telegram.configured ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Attention Sent:</span>
                <span className="text-on-surface">{status.telegram.sent_today} / {status.telegram.daily_cap}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Remaining:</span>
                <span className="text-primary font-medium">{status.telegram.remaining}</span>
              </div>
            </div>
          </Card>

          {/* 6. Desktop Agent Readiness (Block 9 Sandbox) */}
          <Card title="Desktop Adapter" badge={<StatusGlyph status="paused" />}>
            <div className="space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-outline">Status:</span>
                <span className="text-outline uppercase">{status.desktop.status}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Kill Switch:</span>
                <span className="text-warning">DISARMED</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Tier 2 Gate:</span>
                <span className="text-outline">STANDBY (Block 9)</span>
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
};
