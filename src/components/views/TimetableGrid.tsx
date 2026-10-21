import React, { useState, useEffect } from 'react';
import type { WeekSchedule, ClassOccurrence } from '../../api/types';
import { EmptyState } from '../primitives/EmptyState';
import { api } from '../../api/client';

interface TimetableGridProps {
  onInspectClass: (occurrence: ClassOccurrence) => void;
}

export const TimetableGrid: React.FC<TimetableGridProps> = ({ onInspectClass }) => {
  const [schedule, setSchedule] = useState<WeekSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWeek = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getTimetableWeek();
      setSchedule(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load timetable week');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWeek();
  }, []);

  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between pb-4 border-b border-surface-container">
        <div>
          <h2 className="font-sans text-xl font-semibold text-on-surface">Academy (Timetable)</h2>
          <p className="font-mono text-xs text-outline mt-0.5">
            {schedule?.semester ? `${schedule.semester} · ` : ''}Expanded weekly surface from D1
          </p>
        </div>
        <button
          onClick={fetchWeek}
          className="min-h-[44px] sm:min-h-[32px] px-3 font-mono text-xs text-outline hover:text-on-surface bg-surface-container-low hover:bg-surface-container rounded-lg border border-surface-container"
        >
          ↻ Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center py-16 font-mono text-xs text-primary animate-pulse">
          Loading timetable grid...
        </div>
      ) : error ? (
        <div className="text-center py-10 font-mono text-xs text-error">
          Error: {error}
        </div>
      ) : !schedule || schedule.days.length === 0 ? (
        <EmptyState title="No timetable entries" description="No active semester or class slots defined." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
          {schedule.days.map((day, idx) => {
            const dayName = weekdayNames[idx] || `Day ${idx + 1}`;
            const isToday = day.date === new Date().toISOString().slice(0, 10);

            return (
              <div
                key={day.date}
                className={`flex flex-col rounded-xl p-3 border ${
                  isToday
                    ? 'bg-surface-container border-primary shadow-md'
                    : 'bg-surface-container-low border-surface-container'
                }`}
              >
                <div className="flex items-center justify-between mb-3 pb-1 border-b border-surface-container/60">
                  <span className={`font-mono text-xs font-semibold ${isToday ? 'text-primary' : 'text-on-surface'}`}>
                    {dayName}
                  </span>
                  <span className="font-mono text-[10px] text-outline">
                    {day.date.slice(5)}
                  </span>
                </div>

                <div className="flex flex-col gap-2 flex-1">
                  {day.classes.length === 0 ? (
                    <span className="font-sans text-[11px] text-outline italic py-4 text-center">
                      No classes
                    </span>
                  ) : (
                    day.classes.map((cls) => (
                      <div
                        key={cls.id}
                        onClick={() => onInspectClass(cls)}
                        className="p-2 rounded-lg bg-surface-container-lowest hover:bg-surface-container-high transition-colors cursor-pointer border-l-2 border-primary"
                      >
                        <div className="font-sans text-xs font-medium text-on-surface truncate">
                          {cls.subject_name}
                        </div>
                        <div className="font-mono text-[10px] text-outline mt-0.5">
                          {cls.start_time} – {cls.end_time}
                        </div>
                        {cls.room && (
                          <div className="font-mono text-[10px] text-outline-variant">
                            Room {cls.room}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
