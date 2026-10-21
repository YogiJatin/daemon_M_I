import React from 'react';

interface AmbientBannerProps {
  istDateStr?: string;
  istTimeStr?: string;
  headlineSummary?: React.ReactNode;
  subtitle?: string;
}

export const AmbientBanner: React.FC<AmbientBannerProps> = ({
  istDateStr = 'Wed 21 Oct',
  istTimeStr = '10:42 IST',
  headlineSummary,
  subtitle = 'Composed from your tasks and timetable · live D1 sync',
}) => {
  return (
    <section className="flex flex-col gap-2 pt-4 pb-2 border-b border-surface-container/60 mb-6">
      <div className="flex items-center gap-2 font-mono text-xs text-outline tracking-wider">
        <span>{istDateStr}</span>
        <span className="opacity-40">·</span>
        <span className="text-on-surface font-medium">{istTimeStr}</span>
      </div>

      <h1 className="font-sans text-xl sm:text-2xl font-medium tracking-tight text-on-surface leading-snug">
        {headlineSummary || (
          <>
            <span className="underline decoration-error decoration-dotted underline-offset-4">1 overdue</span>,{' '}
            <span className="underline decoration-outline decoration-dotted underline-offset-4">3 due today</span>.{' '}
            <span className="underline decoration-primary decoration-dotted underline-offset-4">Discrete Math starts in 33 minutes</span>.
          </>
        )}
      </h1>

      <div className="font-mono text-[11px] text-outline tracking-wide">
        {subtitle}
      </div>
    </section>
  );
};
