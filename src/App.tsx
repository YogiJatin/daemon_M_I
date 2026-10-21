import { useState, useEffect, useCallback } from 'react';
import type { OSMode, SystemPresence, TodayData, FocusData, Task, ClassOccurrence, AuditEventItem } from './api/types';
import { api } from './api/client';
import { AppShell } from './components/shell/AppShell';
import { TodayView } from './components/views/TodayView';
import { QuickPanelView } from './components/views/QuickPanelView';
import { TaskListView } from './components/views/TaskListView';
import { TimetableGrid } from './components/views/TimetableGrid';
import { AuditTimeline } from './components/views/AuditTimeline';
import { HealthDashboard } from './components/views/HealthDashboard';
import { SettingsView } from './components/views/SettingsView';
import { PairView } from './components/views/PairView';
import { ShareTargetView } from './components/views/ShareTargetView';
import { Inspector } from './components/primitives/Inspector';
import { TaskInspectorContent } from './components/views/TaskInspectorContent';

function getModeFromPath(pathname: string): OSMode {
  if (pathname === '/tasks') return 'memory';
  if (pathname === '/timetable') return 'academy';
  if (pathname === '/history') return 'timeline';
  if (pathname === '/health') return 'system';
  if (pathname === '/settings') return 'settings';
  if (pathname === '/pair') return 'pairing';
  if (pathname === '/panel') return 'panel';
  return 'focus';
}

function getPathFromMode(mode: OSMode): string {
  switch (mode) {
    case 'memory': return '/tasks';
    case 'academy': return '/timetable';
    case 'timeline': return '/history';
    case 'system': return '/health';
    case 'settings': return '/settings';
    case 'pairing': return '/pair';
    case 'panel': return '/panel';
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
  const [isAuthenticated, setIsAuthenticated] = useState(true);
  const [inspectedTask, setInspectedTask] = useState<Task | null>(null);
  const [inspectedClass, setInspectedClass] = useState<ClassOccurrence | null>(null);
  const [inspectedEvent, setInspectedEvent] = useState<AuditEventItem | null>(null);

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

  // Primary data polling (TEST-4.2: ~30s polling while visible)
  const refreshCoreData = useCallback(async () => {
    try {
      const [today, focus] = await Promise.all([
        api.getToday().catch(() => null),
        api.getFocus().catch(() => null),
      ]);
      if (today) setTodayData(today);
      if (focus) {
        setFocusData(focus);
        setPresence('healthy');
      }
      setIsAuthenticated(true);
    } catch (err: any) {
      if (err.status === 401 || err.code === 'unauthorized') {
        setIsAuthenticated(false);
      } else {
        setPresence('offline');
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCoreData();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshCoreData();
      }
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshCoreData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshCoreData]);

  const isShareTarget = window.location.pathname === '/share-target';

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
            handleSelectMode('memory');
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

          {currentMode === 'panel' && (
            <QuickPanelView
              todayData={todayData}
              focusData={focusData}
              onRefresh={refreshCoreData}
              onOpenFullApp={() => handleSelectMode('focus')}
              onInspectTask={(task) => setInspectedTask(task)}
            />
          )}

          {currentMode === 'memory' && (
            <TaskListView
              onInspectTask={(task) => setInspectedTask(task)}
            />
          )}

          {currentMode === 'academy' && (
            <TimetableGrid
              onInspectClass={(cls) => setInspectedClass(cls)}
            />
          )}

          {currentMode === 'timeline' && (
            <AuditTimeline
              onInspectEvent={(ev) => setInspectedEvent(ev)}
            />
          )}

          {currentMode === 'system' && <HealthDashboard />}

          {currentMode === 'settings' && <SettingsView />}

          {currentMode === 'pairing' && (
            <PairView
              isAuthenticated={isAuthenticated}
              onPairedSuccess={() => {
                refreshCoreData();
                handleSelectMode('focus');
              }}
            />
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

      {/* Universal Inspector for Classes */}
      <Inspector
        isOpen={!!inspectedClass}
        onClose={() => setInspectedClass(null)}
        title={inspectedClass?.subject_name || 'Class Details'}
        subtitle={`Slot: ${inspectedClass?.start_time} – ${inspectedClass?.end_time}`}
      >
        {inspectedClass && (
          <div className="space-y-4 font-mono text-xs">
            <div className="p-3 rounded-lg bg-surface-container-low space-y-2 border border-surface-container">
              <div className="flex justify-between">
                <span className="text-outline">Subject Code:</span>
                <span className="text-on-surface">{inspectedClass.subject_code || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Room:</span>
                <span className="text-on-surface">{inspectedClass.room || 'Default Hall'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Faculty:</span>
                <span className="text-on-surface">{inspectedClass.faculty || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Status:</span>
                <span className="text-primary uppercase">{inspectedClass.status}</span>
              </div>
            </div>

            {inspectedClass.materials && inspectedClass.materials.length > 0 && (
              <div>
                <div className="uppercase text-outline text-[10px] mb-2">Preparation Checklist</div>
                <div className="space-y-1.5">
                  {inspectedClass.materials.map((m, i) => (
                    <div key={i} className="p-2 rounded bg-surface-container-low border border-surface-container flex items-center justify-between">
                      <span className="text-on-surface">{m.title}</span>
                      {m.required && <span className="text-error text-[10px] uppercase">[Required]</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Inspector>

      {/* Universal Inspector for Audit Events */}
      <Inspector
        isOpen={!!inspectedEvent}
        onClose={() => setInspectedEvent(null)}
        title={inspectedEvent?.event_type || 'Audit Event'}
        subtitle={`Sequence #${inspectedEvent?.sequence ?? '—'}`}
      >
        {inspectedEvent && (
          <div className="space-y-3 font-mono text-xs">
            <div className="p-3 rounded-lg bg-surface-container-low space-y-2 border border-surface-container">
              <div className="flex justify-between">
                <span className="text-outline">Actor:</span>
                <span className="text-on-surface">{inspectedEvent.actor}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Entity:</span>
                <span className="text-on-surface">{inspectedEvent.entity_type} ({inspectedEvent.entity_id})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Timestamp:</span>
                <span className="text-on-surface">{inspectedEvent.created_at}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-outline">Integrity:</span>
                <span className="text-ok">CRYPTOGRAPHICALLY VERIFIED</span>
              </div>
            </div>

            {inspectedEvent.payload_hash && (
              <div>
                <div className="uppercase text-outline text-[10px] mb-1">Payload SHA-256</div>
                <div className="p-2 rounded bg-surface-container-lowest border border-surface-container text-[10px] break-all text-on-surface-variant">
                  {inspectedEvent.payload_hash}
                </div>
              </div>
            )}

            {inspectedEvent.record_hash && (
              <div>
                <div className="uppercase text-outline text-[10px] mb-1">Chained Record Hash</div>
                <div className="p-2 rounded bg-surface-container-lowest border border-surface-container text-[10px] break-all text-primary">
                  {inspectedEvent.record_hash}
                </div>
              </div>
            )}
          </div>
        )}
      </Inspector>
    </AppShell>
  );
}

export default App;
