import React from 'react';

interface CardProps {
  title?: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const Card: React.FC<CardProps> = ({
  title,
  badge,
  action,
  children,
  className = '',
}) => {
  return (
    <div className={`rounded-xl bg-surface-container-low p-space-md shadow-sm border border-surface-container ${className}`}>
      {(title || badge || action) && (
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-surface-container">
          <div className="flex items-center gap-2">
            {title && (
              <h3 className="font-sans text-sm font-semibold uppercase tracking-wider text-outline">
                {title}
              </h3>
            )}
            {badge}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
};
