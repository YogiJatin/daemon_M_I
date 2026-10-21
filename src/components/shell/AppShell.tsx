import React, { useState } from 'react';
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

  return (
    <div className={`min-h-screen bg-floor text-on-surface antialiased flex flex-col font-sans ${theme}`}>
      {/* 1. Sidebar (Operating Modes Navigation) */}
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
      <main className="flex-1 pt-14 sm:pl-[240px] flex flex-col min-h-screen">
        <div className="w-full max-w-[1360px] mx-auto px-4 sm:px-8 py-4 sm:py-6 flex-1 flex flex-col">
          {children}
        </div>
      </main>
    </div>
  );
};
