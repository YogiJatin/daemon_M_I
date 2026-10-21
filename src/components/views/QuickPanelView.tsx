import React, { useState } from 'react';
import type { TodayData, FocusData, Task } from '../../api/types';
import { EntityRow } from '../primitives/EntityRow';
import { api } from '../../api/client';

interface QuickPanelViewProps {
  todayData: TodayData | null;
  focusData: FocusData | null;
  onRefresh: () => void;
  onOpenFullApp: () => void;
  onInspectTask: (task: Task) => void;
}

export const QuickPanelView: React.FC<QuickPanelViewProps> = ({
  todayData,
  focusData,
  onRefresh,
  onOpenFullApp,
  onInspectTask,
}) => {
  const [quickInput, setQuickInput] = useState('');
  const [snoozeTarget, setSnoozeTarget] = useState<Task | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim()) return;
    setIsSubmitting(true);
    try {
      await api.createTask({ title: quickInput.trim(), priority: 'normal' });
      setQuickInput('');
      onRefresh();
    } catch (err: any) {
      alert(`Add failed: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDone = async (task: Task) => {
    try {
      await api.completeTask(task.id);
      onRefresh();
    } catch (err: any) {
      alert(`Complete failed: ${err.message}`);
    }
  };

  const handleSnooze = async (task: Task, minutes: number) => {
    try {
      await api.snoozeTask(task.id, minutes);
      setSnoozeTarget(null);
      onRefresh();
    } catch (err: any) {
      alert(`Snooze failed: ${err.message}`);
    }
  };

  const overdue = todayData?.overdue_tasks || [];
  const dueToday = todayData?.today_tasks || [];
  const nextClass = focusData?.next_class;

  return (
    <div className="w-full max-w-lg mx-auto bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-space-md shadow-2xl flex flex-col gap-4">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-surface-container pb-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
          <span className="font-sans text-sm font-semibold text-on-surface">Quick Panel</span>
        </div>
        <button
          onClick={onOpenFullApp}
          className="font-mono text-xs text-primary hover:underline min-h-[44px] flex items-center px-2"
        >
          [Open Full OS ↗]
        </button>
      </div>

      {/* Quick Add (TEST-4.6: <= 2 owner interactions) */}
      <form onSubmit={handleQuickAdd} className="flex gap-2">
        <input
          type="text"
          value={quickInput}
          onChange={(e) => setQuickInput(e.target.value)}
          placeholder="Quick add task..."
          className="flex-1 bg-surface-container-low border border-surface-container rounded-lg px-3 py-2 text-xs font-sans text-on-surface placeholder:text-outline focus:outline-none focus:border-primary"
          disabled={isSubmitting}
        />
        <button
          type="submit"
          disabled={isSubmitting || !quickInput.trim()}
          className="min-h-[44px] px-4 bg-primary text-on-primary rounded-lg font-mono text-xs font-medium disabled:opacity-50"
        >
          Add
        </button>
      </form>

      {/* Next Class strip */}
      {nextClass && (
        <div className="px-3 py-2 rounded-lg bg-surface-container-low border-l-2 border-primary flex items-center justify-between text-xs">
          <div className="truncate">
            <span className="font-semibold text-primary">{nextClass.subject_name}</span>
            <span className="text-outline ml-2">@ {nextClass.start_time}</span>
          </div>
          <span className="font-mono text-[10px] text-outline">
            {focusData?.countdowns?.minutes_to_next_class != null ? `${focusData.countdowns.minutes_to_next_class}m` : ''}
          </span>
        </div>
      )}

      {/* Overdue / Due list */}
      <div className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
        {overdue.length === 0 && dueToday.length === 0 && (
          <div className="text-center py-6 text-xs text-outline font-sans">
            No pending tasks for today.
          </div>
        )}

        {overdue.map((t) => (
          <EntityRow
            key={t.id}
            id={t.id}
            title={t.title}
            subtitle={t.deadline_local_date}
            isUrgent={true}
            statusGlyph="error"
            onDone={() => handleDone(t)}
            onSnooze={() => setSnoozeTarget(t)}
            onDetails={() => onInspectTask(t)}
          />
        ))}

        {dueToday.map((t) => (
          <EntityRow
            key={t.id}
            id={t.id}
            title={t.title}
            subtitle={t.deadline_time_local || 'Today'}
            statusGlyph="open"
            onDone={() => handleDone(t)}
            onSnooze={() => setSnoozeTarget(t)}
            onDetails={() => onInspectTask(t)}
          />
        ))}
      </div>

      {/* Quick 2-Tap Snooze Presets Modal */}
      {snoozeTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setSnoozeTarget(null)}
        >
          <div
            className="w-full max-w-xs bg-surface-container-lowest border border-outline-variant/40 rounded-xl p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-sans text-xs font-semibold mb-3">Snooze "{snoozeTarget.title}"</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handleSnooze(snoozeTarget, 15)}
                className="min-h-[44px] px-2 py-2 rounded bg-surface-container font-mono text-xs hover:text-primary"
              >
                +15m
              </button>
              <button
                onClick={() => handleSnooze(snoozeTarget, 60)}
                className="min-h-[44px] px-2 py-2 rounded bg-surface-container font-mono text-xs hover:text-primary"
              >
                +1h
              </button>
              <button
                onClick={() => handleSnooze(snoozeTarget, 180)}
                className="min-h-[44px] px-2 py-2 rounded bg-surface-container font-mono text-xs hover:text-primary"
              >
                +3h
              </button>
              <button
                onClick={() => handleSnooze(snoozeTarget, 1440)}
                className="min-h-[44px] px-2 py-2 rounded bg-surface-container font-mono text-xs hover:text-primary"
              >
                Tomorrow
              </button>
            </div>
            <button
              onClick={() => setSnoozeTarget(null)}
              className="w-full mt-2 min-h-[44px] text-xs font-mono text-outline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
