import React, { useState } from 'react';
import type { TodayData, FocusData, Task } from '../../api/types';
import { AmbientBanner } from '../shell/AmbientBanner';
import { Card } from '../primitives/Card';
import { EntityRow } from '../primitives/EntityRow';
import { EmptyState } from '../primitives/EmptyState';
import { api } from '../../api/client';

interface TodayViewProps {
  todayData: TodayData | null;
  focusData: FocusData | null;
  isLoading: boolean;
  onRefresh: () => void;
  onInspectTask: (task: Task) => void;
}

export const TodayView: React.FC<TodayViewProps> = ({
  todayData,
  focusData,
  onRefresh,
  onInspectTask,
}) => {
  const [snoozeTaskTarget, setSnoozeTaskTarget] = useState<Task | null>(null);

  // AI Strategic Advisory State
  const [advisoryLoading, setAdvisoryLoading] = useState(false);
  const [advisoryResult, setAdvisoryResult] = useState<any | null>(null);
  const [advisoryError, setAdvisoryError] = useState<string | null>(null);

  const handleDone = async (task: Task) => {
    try {
      await api.completeTask(task.id);
      onRefresh();
    } catch (err: any) {
      alert(`Could not complete task: ${err.message}`);
    }
  };

  const handleSnooze = async (task: Task, minutes: number) => {
    try {
      await api.snoozeTask(task.id, minutes);
      setSnoozeTaskTarget(null);
      onRefresh();
    } catch (err: any) {
      alert(`Could not snooze task: ${err.message}`);
    }
  };

  const handleSuggestNext = async () => {
    setAdvisoryLoading(true);
    setAdvisoryError(null);
    try {
      const res = await api.callAssistant('suggest_next');
      setAdvisoryResult(res);
    } catch (err: any) {
      setAdvisoryError(err.message || 'Advisory request failed');
    } finally {
      setAdvisoryLoading(false);
    }
  };

  const overdue = todayData?.overdue_tasks || [];
  const dueToday = todayData?.today_tasks || [];
  const nextClass = focusData?.next_class;
  const budget = focusData?.attention_budget;

  const headline = (
    <>
      {overdue.length > 0 && (
        <>
          <span className="underline decoration-error decoration-dotted underline-offset-4 text-error font-semibold">
            {overdue.length} overdue
          </span>
          ,{' '}
        </>
      )}
      <span className="underline decoration-outline decoration-dotted underline-offset-4">
        {dueToday.length} due today
      </span>
      .{' '}
      {nextClass ? (
        <span className="underline decoration-primary decoration-dotted underline-offset-4 text-primary">
          {nextClass.subject_name} starts in {focusData?.countdowns?.minutes_to_next_class ?? '—'}m
        </span>
      ) : (
        <span className="text-outline">No more lectures scheduled today</span>
      )}
      .
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Ambient Intelligence Briefing */}
      <AmbientBanner
        istDateStr={todayData?.date || 'Live IST'}
        istTimeStr={new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST'}
        headlineSummary={headline}
      />

      {/* 2. Needs Attention Strip (if any overdue) */}
      {overdue.length > 0 && (
        <section className="rounded-lg bg-surface-container-low p-3.5 border-l-2 border-error flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-error" />
            <span className="font-sans text-xs text-on-surface">
              <strong className="text-error">{overdue.length} item(s)</strong> require immediate attention or rescheduling.
            </span>
          </div>
          <button
            onClick={() => onInspectTask(overdue[0])}
            className="text-xs font-mono text-error hover:underline"
          >
            Inspect Oldest →
          </button>
        </section>
      )}

      {/* 3. Main Dashboard Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (7 Cols): Primary Action Horizon */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          {/* Overdue Section */}
          {overdue.length > 0 && (
            <Card
              title="Overdue Tasks"
              badge={<span className="font-mono text-xs text-error font-semibold">({overdue.length})</span>}
            >
              <div className="flex flex-col gap-2">
                {overdue.map((t) => (
                  <EntityRow
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    subtitle={t.deadline_local_date ? `Due ${t.deadline_local_date} ${t.deadline_time_local || ''}` : 'No date'}
                    meta={t.priority}
                    priority={t.priority}
                    statusGlyph="error"
                    onDone={() => handleDone(t)}
                    onSnooze={() => setSnoozeTaskTarget(t)}
                    onDetails={() => onInspectTask(t)}
                    onClick={() => onInspectTask(t)}
                  />
                ))}
              </div>
            </Card>
          )}

          {/* Due Today Section */}
          <Card
            title="Due Today"
            badge={<span className="font-mono text-xs text-outline">({dueToday.length})</span>}
          >
            {dueToday.length === 0 ? (
              <EmptyState title="No tasks due today" description="Everything is clear in today's active window." />
            ) : (
              <div className="flex flex-col gap-2">
                {dueToday.map((t) => (
                  <EntityRow
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    subtitle={t.deadline_time_local ? `Due at ${t.deadline_time_local}` : 'Today'}
                    meta={t.priority}
                    priority={t.priority}
                    statusGlyph={t.priority === 'urgent' ? 'error' : t.priority === 'high' ? 'paused' : 'open'}
                    onDone={() => handleDone(t)}
                    onSnooze={() => setSnoozeTaskTarget(t)}
                    onDetails={() => onInspectTask(t)}
                    onClick={() => onInspectTask(t)}
                  />
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Right Column (5 Cols): Next Class, Advisory & System Context */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          {/* Next Class / Lecture Card */}
          <Card title="Academy — Next Lecture">
            {nextClass ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-sans text-base font-semibold text-on-surface">
                      {nextClass.subject_name}
                    </h4>
                    <p className="font-mono text-xs text-outline mt-0.5">
                      {nextClass.start_time} – {nextClass.end_time} {nextClass.room ? `· Room ${nextClass.room}` : ''}
                    </p>
                  </div>
                  <span className="font-mono text-xs text-primary px-2 py-0.5 rounded bg-surface-container font-medium">
                    in {focusData?.countdowns?.minutes_to_next_class ?? '—'}m
                  </span>
                </div>

                {nextClass.faculty && (
                  <div className="font-sans text-xs text-on-surface-variant">
                    Faculty: {nextClass.faculty}
                  </div>
                )}
              </div>
            ) : (
              <EmptyState title="No classes today" description="No lectures remain on the schedule for today." />
            )}
          </Card>

          {/* AI Strategic Advisory Card */}
          <Card title="AI Strategic Advisory">
            <div className="flex flex-col gap-3 font-mono text-xs">
              <div className="flex items-center justify-between">
                <span className="text-outline">Governed Advisor:</span>
                <button
                  onClick={handleSuggestNext}
                  disabled={advisoryLoading}
                  className="px-2.5 py-1 rounded bg-primary/10 text-primary hover:bg-primary hover:text-on-primary transition-colors text-[11px] font-bold border border-primary/20 disabled:opacity-50"
                >
                  {advisoryLoading ? 'Thinking...' : '✨ Suggest Next'}
                </button>
              </div>

              {advisoryError && (
                <div className="p-2 rounded bg-error-container text-on-error-container text-[11px] border border-error/30">
                  {advisoryError}
                </div>
              )}

              {advisoryResult && (
                <div className="p-3 rounded-lg bg-surface-container-low border border-primary/20 space-y-2">
                  <div className="flex items-center justify-between text-[10px] text-outline">
                    <span>Model: {advisoryResult.provider} ({advisoryResult.duration_ms}ms)</span>
                    {advisoryResult.fallback_triggered && <span className="text-warning">Fallback</span>}
                  </div>
                  <div className="font-sans text-xs font-semibold text-on-surface">
                    👉 {advisoryResult.result?.next_action}
                  </div>
                  {advisoryResult.result?.rationale && (
                    <p className="font-sans text-[11px] text-on-surface-variant leading-relaxed">
                      {advisoryResult.result.rationale}
                    </p>
                  )}
                </div>
              )}

              {!advisoryResult && !advisoryLoading && (
                <p className="font-sans text-[11px] text-outline italic">
                  Tap "Suggest Next" to query your governed AI stack for contextual prioritization based on current schedule and deadlines.
                </p>
              )}
            </div>
          </Card>

          {/* Attention Budget Card */}
          <Card title="Telegram Attention Budget">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between font-mono text-xs">
                <span className="text-outline">Sent Today:</span>
                <span className="text-on-surface font-medium">{budget?.sent_today ?? 0} / {budget?.daily_cap ?? 8}</span>
              </div>
              <div className="w-full bg-surface-container h-2 rounded-full overflow-hidden">
                <div
                  className="bg-primary h-full transition-all duration-300"
                  style={{ width: `${Math.min(100, (((budget?.sent_today ?? 0) / (budget?.daily_cap ?? 8)) * 100))}%` }}
                />
              </div>
              <div className="font-mono text-[11px] text-outline flex items-center justify-between">
                <span>Remaining: {budget?.remaining ?? 8}</span>
                <span>Cap: {budget?.daily_cap ?? 8} max/day</span>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Snooze Presets Modal / Sheet */}
      {snoozeTaskTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setSnoozeTaskTarget(null)}
        >
          <div
            className="w-full max-w-sm bg-surface-container-lowest border border-outline-variant/40 rounded-xl p-space-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-sans text-sm font-semibold text-on-surface mb-1">
              Snooze: {snoozeTaskTarget.title}
            </h3>
            <p className="font-mono text-xs text-outline mb-4">
              Select snooze duration (TEST-4.6 preset):
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: '+15 Minutes', mins: 15 },
                { label: '+1 Hour', mins: 60 },
                { label: '+3 Hours', mins: 180 },
                { label: 'Tomorrow 09:00', mins: 1440 },
              ].map((preset) => (
                <button
                  key={preset.mins}
                  onClick={() => handleSnooze(snoozeTaskTarget, preset.mins)}
                  className="min-h-[44px] px-3 py-2 rounded-lg bg-surface-container-low hover:bg-surface-container border border-surface-container font-mono text-xs text-on-surface hover:text-primary transition-colors text-center"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setSnoozeTaskTarget(null)}
              className="w-full mt-3 min-h-[44px] py-2 rounded font-mono text-xs text-outline hover:text-on-surface text-center"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
