import React from 'react';
import type { StatusGlyphType } from '../../api/types';

interface StatusGlyphProps {
  status: StatusGlyphType | string;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}

export const StatusGlyph: React.FC<StatusGlyphProps> = ({
  status,
  size = 'md',
  label,
  className = '',
}) => {
  const sizeClasses = {
    sm: 'w-2 h-2 text-[10px]',
    md: 'w-2.5 h-2.5 text-xs',
    lg: 'w-3.5 h-3.5 text-sm',
  }[size];

  const getStyle = () => {
    switch (status) {
      case 'healthy':
      case 'done':
      case 'completed':
      case 'audit_verified':
      case 'execution_complete':
        return {
          bg: 'bg-ok',
          ring: 'ring-ok/30',
          text: 'text-ok',
          symbol: '●',
        };
      case 'loading':
      case 'syncing':
      case 'processing':
      case 'execution_running':
        return {
          bg: 'bg-primary animate-pulse',
          ring: 'ring-primary/40',
          text: 'text-primary',
          symbol: '◐',
        };
      case 'paused':
      case 'uncertain-send':
      case 'degraded':
      case 'provider_fallback':
      case 'audit_warning':
      case 'requires_approval':
      case 'execution_pending':
        return {
          bg: 'bg-warning',
          ring: 'ring-warning/30',
          text: 'text-warning',
          symbol: '▲',
        };
      case 'error':
      case 'offline':
      case 'verification_failed':
      case 'privacy_restricted':
        return {
          bg: 'bg-error',
          ring: 'ring-error/40',
          text: 'text-error',
          symbol: '■',
        };
      case 'empty':
        return {
          bg: 'bg-outline',
          ring: 'ring-outline/20',
          text: 'text-outline',
          symbol: '○',
        };
      case 'open':
      default:
        return {
          bg: 'bg-outline-variant',
          ring: 'ring-outline/20',
          text: 'text-on-surface-variant',
          symbol: '○',
        };
    }
  };

  const style = getStyle();

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        className={`rounded-full shrink-0 ring-2 ${sizeClasses} ${style.bg} ${style.ring}`}
        title={status}
      />
      {label && (
        <span className={`font-mono text-xs uppercase tracking-wider ${style.text}`}>
          {label}
        </span>
      )}
    </span>
  );
};
