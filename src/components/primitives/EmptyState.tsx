import React from 'react';
import { StatusGlyph } from './StatusGlyph';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  action,
}) => {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center rounded-lg border border-dashed border-outline-variant/40 bg-surface-container-lowest/50">
      <StatusGlyph status="empty" size="md" className="mb-2" />
      <p className="font-sans text-sm font-medium text-on-surface">{title}</p>
      {description && (
        <p className="font-sans text-xs text-outline mt-1 max-w-xs">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
};
