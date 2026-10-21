import React, { useState, useEffect } from 'react';
import { Card } from '../primitives/Card';
import { api } from '../../api/client';

export const SettingsView: React.FC = () => {
  const [isPaused, setIsPaused] = useState(false);
  const [session, setSession] = useState<any>(null);

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
    <div className="flex flex-col gap-6 max-w-2xl">
      <div className="pb-4 border-b border-surface-container">
        <h2 className="font-sans text-xl font-semibold text-on-surface">Operating System Settings</h2>
        <p className="font-mono text-xs text-outline mt-0.5">
          Notification planner gates, quiet hours, and session credentials
        </p>
      </div>

      {/* Global Reminder Pause Gate (Rule 13) */}
      <Card title="Emergency Dispatch Gate">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-sans text-sm font-medium text-on-surface">Reminders Master Gate</h4>
            <p className="font-mono text-xs text-outline mt-0.5">
              Pause all Telegram outbound notifications immediately.
            </p>
          </div>
          <button
            onClick={handleTogglePause}
            className={`min-h-[44px] px-4 rounded-lg font-mono text-xs font-semibold transition-colors ${
              isPaused
                ? 'bg-ok text-on-primary'
                : 'bg-error text-white'
            }`}
          >
            {isPaused ? 'Resume Reminders' : 'Pause Reminders'}
          </button>
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
            <span className="text-on-surface">22:00 – 07:00 IST</span>
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
  );
};
