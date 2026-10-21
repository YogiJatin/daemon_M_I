import React from 'react';
import { PresenceRing } from '../primitives/PresenceRing';
import type { SystemPresence } from '../../api/types';

interface HeaderProps {
  presence: SystemPresence;
  schedulerQosText?: string;
  onOpenCommand: () => void;
  onToggleSidebarMobile: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  presence,
  schedulerQosText = '38s ago · 96%',
  onOpenCommand,
  onToggleSidebarMobile,
  theme,
  onToggleTheme,
}) => {
  return (
    <header className="fixed top-0 left-0 right-0 sm:left-[240px] h-14 bg-surface-container-lowest/90 backdrop-blur-md z-30 border-b border-surface-container flex items-center justify-between px-space-md sm:px-space-lg">
      <div className="flex items-center gap-space-sm">
        {/* Mobile menu toggle */}
        <button
          onClick={onToggleSidebarMobile}
          className="sm:hidden min-h-[44px] min-w-[44px] flex items-center justify-center font-mono text-lg text-outline hover:text-on-surface"
          aria-label="Toggle Navigation"
        >
          ☰
        </button>

        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-container-low border border-surface-container">
          <span className="w-2 h-2 rounded-full bg-primary" />
          <span className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant font-medium">
            OS Core
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 sm:gap-5">
        {/* Scheduler Presence Indicator */}
        <PresenceRing
          presence={presence}
          label="Scheduler"
          sublabel={schedulerQosText}
          className="hidden md:inline-flex"
        />

        {/* Global Command Bar Trigger */}
        <button
          onClick={onOpenCommand}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container-low hover:bg-surface-container border border-surface-container text-outline hover:text-on-surface transition-colors cursor-pointer min-h-[44px] sm:min-h-[32px]"
        >
          <span className="font-sans text-xs">Command...</span>
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 rounded bg-surface-container font-mono text-[10px] text-outline border border-surface-container-high">
            Ctrl K
          </kbd>
        </button>

        {/* Theme Toggle */}
        <button
          onClick={onToggleTheme}
          className="w-8 h-8 rounded-lg bg-surface-container-low hover:bg-surface-container flex items-center justify-center font-mono text-xs text-outline hover:text-on-surface transition-colors"
          title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}
        >
          {theme === 'dark' ? '☼' : '☽'}
        </button>
      </div>
    </header>
  );
};
