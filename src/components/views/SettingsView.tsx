import React, { useState, useEffect } from 'react';
import { Card } from '../primitives/Card';
import { HealthDashboard } from './HealthDashboard';
import { PairView } from './PairView';
import { api } from '../../api/client';

export const SettingsView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'settings' | 'health' | 'devices'>('settings');
  const [isPaused, setIsPaused] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [pushStatus, setPushStatus] = useState<string | null>(null);
  const [isPushLoading, setIsPushLoading] = useState(false);

  const handleEnableNotifications = async () => {
    setIsPushLoading(true);
    setPushStatus(null);
    try {
      const res = await fetch('/api/v1/push/config');
      const data = ((await res.json().catch(() => ({}))) as any) || {};
      if (!data.ok || !data.data?.vapid_configured || !data.data?.public_key) {
        setPushStatus(
          data.data?.message ||
            'Web push notifications require VAPID keys configured by administrator. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY secrets.'
        );
        setIsPushLoading(false);
        return;
      }
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: data.data.public_key,
        });
        await fetch('/api/v1/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub.toJSON()),
        });
        setPushStatus('Web push notifications enabled successfully.');
      } else {
        setPushStatus('Push notifications not supported in this browser.');
      }
    } catch (err: any) {
      setPushStatus(err.message || 'Failed to enable notifications.');
    } finally {
      setIsPushLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const st = await api.getSystemStatus();
      setIsPaused(st.reminders_paused);
      const me = await api.getMe().catch(() => null);
      setSession(me);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleTogglePause = async () => {
    try {
      if (isPaused) {
        await api.resumeReminders();
        setIsPaused(false);
      } else {
        await api.pauseReminders();
        setIsPaused(true);
      }
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full">
      {/* Settings Navigation Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-surface-container pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-on-surface flex items-center gap-2">
            <span>⚙</span> System Settings & Controls
          </h1>
          <p className="text-xs text-outline font-mono mt-1">
            Dispatch gates, quiet hours, subsystem health vitals, and device pairing
          </p>
        </div>

        <div className="flex items-center gap-1 bg-surface-container-lowest p-1 rounded-lg border border-surface-container self-start">
          {[
            { id: 'settings', label: 'Preferences' },
            { id: 'health', label: 'Status' },
            { id: 'devices', label: 'Devices & Obsidian' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`min-h-[44px] px-3 py-1.5 rounded-md text-xs font-mono font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-surface-container text-primary font-bold shadow-sm'
                  : 'text-outline hover:text-on-surface'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab 1: Settings & Policies */}
      {activeTab === 'settings' && (
        <div className="flex flex-col gap-6 max-w-2xl">
          {/* Global Reminder Pause Gate (Rule 13) */}
          <Card title="Emergency Dispatch Gate">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h4 className="font-sans text-sm font-medium text-on-surface">Reminders Master Gate</h4>
                <p className="font-mono text-xs text-outline mt-0.5">
                  Pause all Telegram outbound notifications immediately.
                </p>
              </div>
              <button
                onClick={handleTogglePause}
                className={`min-h-[44px] px-4 rounded-lg font-mono text-xs font-semibold transition-colors shrink-0 ${
                  isPaused ? 'bg-ok text-on-primary' : 'bg-error text-white'
                }`}
              >
                {isPaused ? 'Resume Reminders' : 'Pause Reminders'}
              </button>
            </div>
          </Card>

          {/* Web Push Fallback (Block 4, A10) */}
          <Card title="Web Push Notifications Fallback">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h4 className="font-sans text-sm font-medium text-on-surface">Browser Push Notifications</h4>
                  <p className="font-mono text-xs text-outline mt-0.5">
                    Fallback alert channel when Telegram delivery is unavailable or paused.
                  </p>
                </div>
                <button
                  onClick={handleEnableNotifications}
                  disabled={isPushLoading}
                  className="min-h-[44px] px-4 rounded-lg font-mono text-xs font-semibold bg-surface-container text-on-surface hover:bg-surface-container-high transition-colors disabled:opacity-50 shrink-0"
                >
                  {isPushLoading ? 'Checking...' : 'Enable notifications'}
                </button>
              </div>
              {pushStatus && (
                <div className="p-3 bg-surface-container rounded-lg font-mono text-xs text-outline border border-surface-container-high">
                  {pushStatus}
                </div>
              )}
            </div>
          </Card>

          {/* Quiet Hours & Attention Budget Policy */}
          <Card title="Scheduler Invariants">
            <div className="space-y-3 font-mono text-xs">
              <div className="flex justify-between py-1 border-b border-surface-container">
                <span className="text-outline">Timezone Policy:</span>
                <span className="text-on-surface">Asia/Kolkata (IST only)</span>
              </div>
              <div className="flex justify-between py-1 border-b border-surface-container">
                <span className="text-outline">Quiet Hours Window:</span>
                <span className="text-on-surface">23:00 – 07:00 IST</span>
              </div>
              <div className="flex justify-between py-1 border-b border-surface-container">
                <span className="text-outline">Daily Attention Cap:</span>
                <span className="text-on-surface">8 outbound messages/day</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-outline">Cron Batch Cap:</span>
                <span className="text-on-surface">3 rows bounded (max 5)</span>
              </div>
            </div>
          </Card>

          {/* Active Session Info */}
          <Card title="Active PWA Session">
            <div className="space-y-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-outline">Owner User ID:</span>
                <span className="text-on-surface">{session?.owner_user_id || '8364430714'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Session Cookie:</span>
                <span className="text-ok">HttpOnly Secure</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Expires At:</span>
                <span className="text-outline truncate max-w-[200px]">{session?.expires_at || '7 days rolling'}</span>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Tab 2: System Health (Integrated) */}
      {activeTab === 'health' && (
        <div>
          <HealthDashboard />
        </div>
      )}

      {/* Tab 3: Devices & Obsidian Mirror (Integrated) */}
      {activeTab === 'devices' && (
        <div className="flex flex-col gap-6 max-w-2xl">
          <Card title="Desktop Outbox Mirror">
            <div className="space-y-3 font-mono text-xs">
              <p className="text-on-surface-variant font-sans">
                The desktop agent polls export jobs from Cloudflare D1 via <code className="bg-surface-container px-1 py-0.5 rounded">/api/v1/desktop/mirror-jobs</code> and writes them directly to your Obsidian vault.
              </p>
              <div className="flex justify-between py-1 border-b border-surface-container">
                <span className="text-outline">Architecture:</span>
                <span className="text-on-surface">Outbound Polling (Zero Inbound Ports)</span>
              </div>
              <div className="flex justify-between py-1 border-b border-surface-container">
                <span className="text-outline">Status:</span>
                <span className="text-ok font-semibold">Active & Governed</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-outline">Local Service:</span>
                <span className="text-on-surface">desktop_agent/install-service.ps1</span>
              </div>
            </div>
          </Card>

          <Card title="Device Re-pairing">
            <PairView
              isAuthenticated={true}
              onPairedSuccess={() => {
                fetchSettings();
              }}
            />
          </Card>
        </div>
      )}
    </div>
  );
};
