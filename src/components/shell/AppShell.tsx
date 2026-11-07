import React, { useState, useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { CommandLayer } from './CommandLayer';
import type { OSMode, SystemPresence } from '../../api/types';

interface AppShellProps {
  currentMode: OSMode;
  onSelectMode: (mode: OSMode) => void;
  presence?: SystemPresence;
  schedulerQosText?: string;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onRefreshData?: () => void;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  currentMode,
  onSelectMode,
  presence = 'healthy',
  schedulerQosText = '38s ago · 96%',
  theme,
  onToggleTheme,
  onRefreshData,
  children,
}) => {
  const [isSidebarOpenMobile, setIsSidebarOpenMobile] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);

  // Global Ctrl+K / Cmd+K listener
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const mobileNavItems: Array<{ mode: OSMode; label: string; icon: string }> = [
    { mode: 'focus', label: 'Today', icon: '◎' },
    { mode: 'tasks', label: 'Tasks', icon: '✓' },
    { mode: 'inbox', label: 'Inbox', icon: '📥' },
    { mode: 'memory', label: 'Memory', icon: '🧠' },
    { mode: 'settings', label: 'Settings', icon: '⚙' },
  ];

  return (
    <div className={`min-h-screen bg-floor text-on-surface antialiased flex flex-col font-sans overflow-x-hidden ${theme}`}>
      {/* 1. Sidebar (Desktop Navigation) */}
      <Sidebar
        currentMode={currentMode}
        onSelectMode={onSelectMode}
        isOpenMobile={isSidebarOpenMobile}
        onCloseMobile={() => setIsSidebarOpenMobile(false)}
      />

      {/* 2. Top Header (Presence Layer + Quick Command Trigger) */}
      <Header
        presence={presence}
        schedulerQosText={schedulerQosText}
        onOpenCommand={() => setIsCommandOpen(true)}
        onToggleSidebarMobile={() => setIsSidebarOpenMobile((v) => !v)}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />

      {/* 3. Global Command Layer (Ctrl+K) */}
      <CommandLayer
        isOpen={isCommandOpen}
        onClose={() => setIsCommandOpen(false)}
        onSelectMode={onSelectMode}
        onTaskCreated={onRefreshData}
      />

      {/* 4. Content Region (Primary OS Workspace) */}
      <main className="flex-1 pt-14 pb-20 sm:pb-6 sm:pl-[240px] flex flex-col min-h-screen">
        <div className="w-full max-w-[1360px] mx-auto px-3 sm:px-8 py-3 sm:py-6 flex-1 flex flex-col">
          {children}
        </div>
      </main>

      {/* 5. Mobile Bottom Navigation Bar (390px Mobile First) */}
      <nav className="fixed bottom-0 left-0 right-0 h-16 bg-surface-container-lowest/95 backdrop-blur-md border-t border-surface-container z-30 flex items-center justify-around sm:hidden px-2">
        {mobileNavItems.map((item) => {
          const isActive = currentMode === item.mode;
          return (
            <button
              key={item.mode}
              onClick={() => onSelectMode(item.mode)}
              className={`flex flex-col items-center justify-center flex-1 min-h-[48px] py-1 transition-colors ${
                isActive ? 'text-primary font-bold' : 'text-outline hover:text-on-surface'
              }`}
            >
              <span className="text-base leading-none mb-1">{item.icon}</span>
              <span className="text-[10px] font-mono tracking-tight">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};
