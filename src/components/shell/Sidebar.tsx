import React from 'react';
import type { OSMode } from '../../api/types';

interface SidebarProps {
  currentMode: OSMode;
  onSelectMode: (mode: OSMode) => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentMode,
  onSelectMode,
  isOpenMobile,
  onCloseMobile,
}) => {
  const primaryNav: Array<{ mode: OSMode; label: string; icon: string }> = [
    { mode: 'focus', label: 'Today', icon: '◎' },
    { mode: 'tasks', label: 'Tasks', icon: '✓' },
    { mode: 'inbox', label: 'Inbox', icon: '📥' },
    { mode: 'memory', label: 'Memory', icon: '🧠' },
    { mode: 'settings', label: 'Settings', icon: '⚙' },
  ];

  const handleNavClick = (mode: OSMode) => {
    onSelectMode(mode);
    onCloseMobile();
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 z-40 bg-black/60 sm:hidden"
          onClick={onCloseMobile}
        />
      )}

      <aside
        className={`fixed top-0 bottom-0 left-0 w-[240px] bg-surface-container-lowest z-50 flex flex-col justify-between border-r border-surface-container transition-transform duration-200 sm:translate-x-0 ${
          isOpenMobile ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col overflow-y-auto">
          {/* Logo / OS Identity */}
          <div className="h-14 px-space-md flex items-center justify-between border-b border-surface-container bg-surface-container-lowest shrink-0">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-primary stroke-current fill-none stroke-2" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" strokeDasharray="48 10" strokeLinecap="round" />
              </svg>
              <span className="font-sans text-sm font-semibold tracking-tight text-on-surface">
                Personal AI OS
              </span>
            </div>
            <button
              onClick={onCloseMobile}
              className="sm:hidden min-h-[44px] min-w-[44px] flex items-center justify-center text-outline hover:text-on-surface"
            >
              ✕
            </button>
          </div>

          {/* Navigation Items (5 Primary Tabs) */}
          <div className="px-3 py-4 flex flex-col gap-2">
            <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-outline">
              Operational Horizon
            </div>
            <nav className="flex flex-col gap-1">
              {primaryNav.map((item) => {
                const isActive = currentMode === item.mode;
                return (
                  <button
                    key={item.mode}
                    onClick={() => handleNavClick(item.mode)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors text-left min-h-[44px] ${
                      isActive
                        ? 'bg-surface-container text-primary font-bold border-l-2 border-primary shadow-sm'
                        : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low'
                    }`}
                  >
                    <span className="font-mono text-sm w-5 text-center opacity-90">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Footer / System Meta */}
        <div className="p-space-md border-t border-surface-container shrink-0">
          <div className="flex items-center justify-between text-xs font-mono text-outline">
            <span>D1 Monolith</span>
            <span className="text-[10px] text-ok font-semibold">ONLINE</span>
          </div>
        </div>
      </aside>
    </>
  );
};
