import { useState, useEffect, useCallback } from 'react';
import type { OSMode, SystemPresence, TodayData, FocusData, Task } from './api/types';
import { api } from './api/client';
import { AppShell } from './components/shell/AppShell';
import { TodayView } from './components/views/TodayView';
import { TaskListView } from './components/views/TaskListView';
import { InboxView } from './components/views/InboxView';
import { MemoryView } from './components/views/MemoryView';
import { SettingsView } from './components/views/SettingsView';
import { PairView } from './components/views/PairView';
import { ShareTargetView } from './components/views/ShareTargetView';
import { Inspector } from './components/primitives/Inspector';
import { TaskInspectorContent } from './components/views/TaskInspectorContent';

function getModeFromPath(pathname: string): OSMode {
  if (pathname === '/tasks') return 'tasks';
  if (pathname === '/inbox') return 'inbox';
  if (pathname === '/memory') return 'memory';
  if (pathname === '/settings' || pathname === '/health') return 'settings';
  if (pathname === '/pair') return 'pairing';
  return 'focus';
}

function getPathFromMode(mode: OSMode): string {
  switch (mode) {
    case 'tasks': return '/tasks';
    case 'inbox': return '/inbox';
    case 'memory': return '/memory';
    case 'settings': return '/settings';
    case 'pairing': return '/pair';
    case 'focus':
    default:
      return '/';
  }
}

export function App() {
  const [currentMode, setCurrentMode] = useState<OSMode>(() => getModeFromPath(window.location.pathname));
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [todayData, setTodayData] = useState<TodayData | null>(null);
  const [focusData, setFocusData] = useState<FocusData | null>(null);
  const [presence, setPresence] = useState<SystemPresence>('healthy');
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [inspectedTask, setInspectedTask] = useState<Task | null>(null);

  // Sync mode with browser history
  const handleSelectMode = (mode: OSMode) => {
    setCurrentMode(mode);
    const newPath = getPathFromMode(mode);
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, '', newPath);
    }
  };

  useEffect(() => {
    const handlePopState = () => {
      setCurrentMode(getModeFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Theme synchronization
  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      if (next === 'light') {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      } else {
        document.documentElement.classList.remove('light');
        document.documentElement.classList.add('dark');
      }
      return next;
    });
  };

  // Primary data polling (~30s polling while visible)
  const refreshCoreData = useCallback(async () => {
    try {
      // 1. Verify cryptographic session first via /api/v1/auth/me
      await api.getMe();
      setIsAuthenticated(true);

      // 2. Load dashboard read models
      const [today, focus] = await Promise.all([
        api.getToday().catch((err) => {
          if (err?.status === 401 || err?.code === 'unauthorized') throw err;
          return null;
        }),
        api.getFocus().catch((err) => {
          if (err?.status === 401 || err?.code === 'unauthorized') throw err;
          return null;
        }),
      ]);
      if (today) setTodayData(today);
      if (focus) {
        setFocusData(focus);
        setPresence('healthy');
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.code === 'unauthorized') {
        setIsAuthenticated(false);
        setTodayData(null);
        setFocusData(null);
      } else {
        setPresence('offline');
      }
    } finally {
      setIsLoading(false);
      setIsAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    refreshCoreData();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && isAuthenticated) {
        refreshCoreData();
      }
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isAuthenticated) {
        refreshCoreData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshCoreData, isAuthenticated]);

  const isShareTarget = window.location.pathname === '/share-target';

  // Auth gate: Loading state during initial cryptographic session verification
  if (isAuthChecking) {
    return (
      <div className={`min-h-screen bg-floor text-on-surface antialiased flex items-center justify-center font-sans ${theme}`}>
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="font-mono text-xs text-outline">Verifying cryptographic session...</span>
        </div>
      </div>
    );
  }

  // Auth gate: Unauthenticated users MUST see the Device Pairing Gate first
  if (!isAuthenticated) {
    return (
      <div className={`min-h-screen bg-floor text-on-surface antialiased flex flex-col justify-center px-4 font-sans ${theme}`}>
        <PairView
          isAuthenticated={false}
          onPairedSuccess={async () => {
            await refreshCoreData();
            handleSelectMode('focus');
          }}
        />
      </div>
    );
  }

  return (
    <AppShell
      currentMode={currentMode}
      onSelectMode={handleSelectMode}
      presence={presence}
      theme={theme}
      onToggleTheme={toggleTheme}
      onRefreshData={refreshCoreData}
    >
      {/* Share Target Routing */}
      {isShareTarget ? (
        <ShareTargetView
          onSaved={() => {
            refreshCoreData();
            handleSelectMode('tasks');
          }}
          onCancel={() => handleSelectMode('focus')}
        />
      ) : (
        <>
          {currentMode === 'focus' && (
            <TodayView
              todayData={todayData}
              focusData={focusData}
              isLoading={isLoading}
              onRefresh={refreshCoreData}
              onInspectTask={(task) => setInspectedTask(task)}
            />
          )}

          {currentMode === 'tasks' && (
            <TaskListView
              onInspectTask={(task) => setInspectedTask(task)}
            />
          )}

          {currentMode === 'inbox' && (
            <InboxView
              onTaskCreated={refreshCoreData}
            />
          )}

          {currentMode === 'memory' && (
            <MemoryView />
          )}

          {currentMode === 'settings' && (
            <SettingsView />
          )}

          {currentMode === 'pairing' && (
            <div className="max-w-md mx-auto w-full py-6">
              <PairView
                isAuthenticated={isAuthenticated}
                onPairedSuccess={() => {
                  refreshCoreData();
                  handleSelectMode('focus');
                }}
              />
            </div>
          )}
        </>
      )}

      {/* Universal Inspector for Tasks */}
      <Inspector
        isOpen={!!inspectedTask}
        onClose={() => setInspectedTask(null)}
        title={inspectedTask?.title || 'Directive Inspector'}
        subtitle={`Task ID: ${inspectedTask?.id || ''}`}
      >
        {inspectedTask && (
          <TaskInspectorContent
            task={inspectedTask}
            onRefresh={refreshCoreData}
            onClose={() => setInspectedTask(null)}
          />
        )}
      </Inspector>
    </AppShell>
  );
}

export default App;
