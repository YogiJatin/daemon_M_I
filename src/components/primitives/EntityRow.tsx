import React from 'react';
import { StatusGlyph } from './StatusGlyph';
import type { StatusGlyphType, Priority } from '../../api/types';

export interface EntityRowProps {
  id?: string;
  title: string;
  subtitle?: React.ReactNode;
  meta?: string;
  statusGlyph?: StatusGlyphType | string;
  priority?: Priority;
  isCompleted?: boolean;
  isUrgent?: boolean;
  badge?: string;
  onClick?: () => void;
  onDone?: () => void;
  onSnooze?: () => void;
  onDetails?: () => void;
  className?: string;
}

export const EntityRow: React.FC<EntityRowProps> = ({
  title,
  subtitle,
  meta,
  statusGlyph = 'open',
  priority,
  isCompleted = false,
  isUrgent = false,
  badge,
  onClick,
  onDone,
  onSnooze,
  onDetails,
  className = '',
}) => {
  return (
    <div
      onClick={onClick}
      className={`group flex items-center justify-between px-space-md py-3 rounded-lg bg-surface-container-low hover:bg-surface-container transition-colors border-l-2 ${
        isUrgent
          ? 'border-error'
          : priority === 'high'
          ? 'border-secondary'
          : isCompleted
          ? 'border-ok opacity-60'
          : 'border-transparent'
      } ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      <div className="flex items-center gap-space-sm min-w-0 flex-1 pr-2">
        <StatusGlyph status={statusGlyph} size="sm" />

        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`font-sans text-sm font-medium text-on-surface truncate ${
                isCompleted ? 'line-through text-outline' : ''
              }`}
            >
              {title}
            </span>
            {badge && (
              <span className="font-mono text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface-container-high text-outline">
                {badge}
              </span>
            )}
          </div>

          {(subtitle || meta) && (
            <div className="flex items-center gap-2 mt-0.5">
              {subtitle && (
                <span className="font-sans text-xs text-on-surface-variant truncate">
                  {subtitle}
                </span>
              )}
              {meta && (
                <span className="font-mono text-[11px] text-outline">
                  {meta}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Action buttons (Touch target >= 44px on mobile) */}
      <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        {onDone && !isCompleted && (
          <button
            onClick={onDone}
            className="min-h-[44px] min-w-[44px] sm:min-h-[28px] sm:min-w-0 sm:px-2.5 sm:py-1 flex items-center justify-center font-mono text-xs text-ok hover:text-on-surface bg-surface-container hover:bg-surface-container-high rounded transition-colors"
            title="Mark Done"
          >
            [Done]
          </button>
        )}
        {onSnooze && !isCompleted && (
          <button
            onClick={onSnooze}
            className="min-h-[44px] min-w-[44px] sm:min-h-[28px] sm:min-w-0 sm:px-2.5 sm:py-1 flex items-center justify-center font-mono text-xs text-secondary hover:text-on-surface bg-surface-container hover:bg-surface-container-high rounded transition-colors"
            title="Snooze"
          >
            [Snooze]
          </button>
        )}
        {onDetails && (
          <button
            onClick={onDetails}
            className="min-h-[44px] min-w-[44px] sm:min-h-[28px] sm:min-w-0 sm:px-2 sm:py-1 flex items-center justify-center font-mono text-xs text-outline hover:text-on-surface bg-surface-container hover:bg-surface-container-high rounded transition-colors"
            title="Details"
          >
            →
          </button>
        )}
      </div>
    </div>
  );
};
