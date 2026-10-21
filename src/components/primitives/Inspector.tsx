import React from 'react';
import { BottomSheet } from './BottomSheet';

export interface InspectorProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

export const Inspector: React.FC<InspectorProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
}) => {
  if (!isOpen) return null;

  return (
    <>
      {/* Mobile: Bottom Sheet */}
      <BottomSheet isOpen={isOpen} onClose={onClose} title={title} subtitle={subtitle}>
        {children}
      </BottomSheet>

      {/* Desktop: Right-side fixed inspector panel */}
      <aside className="hidden sm:flex fixed top-14 right-0 bottom-0 w-[420px] bg-surface-container-lowest border-l border-surface-container z-40 flex-col shadow-2xl animate-fade-in">
        <div className="h-14 px-space-lg flex items-center justify-between border-b border-surface-container bg-surface-container-lowest">
          <div>
            <h3 className="font-sans text-sm font-semibold text-on-surface">{title}</h3>
            {subtitle && <p className="font-mono text-[11px] text-outline">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-surface-container font-mono text-xs text-outline hover:text-on-surface transition-colors"
            title="Close Inspector (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-space-lg space-y-space-md">
          {children}
        </div>
      </aside>
    </>
  );
};
