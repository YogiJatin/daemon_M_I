import React from 'react';
import type { SystemPresence } from '../../api/types';

interface PresenceRingProps {
  presence: SystemPresence | string;
  size?: number;
  label?: string;
  sublabel?: string;
  progressPercent?: number; // 0 to 100
  onClick?: () => void;
  className?: string;
}

export const PresenceRing: React.FC<PresenceRingProps> = ({
  presence,
  size = 28,
  label,
  sublabel,
  progressPercent = 96,
  onClick,
  className = '',
}) => {
  const radius = 12;
  const circumference = 2 * Math.PI * radius; // ~75.4
  const strokeDashoffset = circumference - (circumference * Math.min(100, Math.max(0, progressPercent))) / 100;

  const getColor = () => {
    switch (presence) {
      case 'healthy':
      case 'execution_complete':
        return { stroke: 'stroke-primary', dot: 'bg-primary' };
      case 'ai_busy':
      case 'syncing':
      case 'scheduler_running':
      case 'execution_running':
        return { stroke: 'stroke-primary animate-spin', dot: 'bg-primary animate-ping' };
      case 'degraded':
      case 'provider_fallback':
      case 'audit_warning':
      case 'waiting_approval':
      case 'notifications_pending':
        return { stroke: 'stroke-warning', dot: 'bg-warning' };
      case 'offline':
      case 'verification_failed':
      case 'privacy_restricted':
        return { stroke: 'stroke-error', dot: 'bg-error' };
      default:
        return { stroke: 'stroke-outline', dot: 'bg-outline' };
    }
  };

  const color = getColor();

  return (
    <div
      onClick={onClick}
      className={`inline-flex items-center gap-2 select-none ${onClick ? 'cursor-pointer hover:opacity-90' : ''} ${className}`}
      title={`Presence: ${presence}`}
    >
      <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <svg
          className={`-rotate-90 ${presence.includes('running') || presence === 'syncing' ? 'animate-spin' : ''}`}
          width={size}
          height={size}
          viewBox="0 0 28 28"
        >
          <circle
            className="stroke-surface-container-high fill-none"
            cx="14"
            cy="14"
            r={radius}
            strokeWidth="1.5"
          />
          <circle
            className={`${color.stroke} fill-none transition-all duration-500`}
            cx="14"
            cy="14"
            r={radius}
            strokeWidth="1.5"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
          />
        </svg>
        <span className={`absolute w-1.5 h-1.5 rounded-full ${color.dot}`} />
      </div>

      {(label || sublabel) && (
        <div className="flex flex-col text-left">
          {label && (
            <span className="font-mono text-xs font-medium text-on-surface leading-tight">
              {label}
            </span>
          )}
          {sublabel && (
            <span className="font-mono text-[10px] text-outline leading-tight">
              {sublabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
