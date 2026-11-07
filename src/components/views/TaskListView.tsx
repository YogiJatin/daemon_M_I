import React, { useState, useEffect } from 'react';
import type { Task } from '../../api/types';
import { EntityRow } from '../primitives/EntityRow';
import { EmptyState } from '../primitives/EmptyState';
import { Card } from '../primitives/Card';
import { api } from '../../api/client';

interface TaskListViewProps {
  onInspectTask: (task: Task) => void;
}

export const TaskListView: React.FC<TaskListViewProps> = ({ onInspectTask }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'completed' | 'all'>('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.getTasks({
        status: statusFilter === 'all' ? undefined : statusFilter,
      });
      setTasks(res.tasks);
    } catch (err: any) {
      setError(err.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, [statusFilter]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim() || creating) return;
    try {
      setCreating(true);
      await api.createTask({ title: newTaskTitle.trim(), priority: 'normal' });
      setNewTaskTitle('');
      fetchTasks();
    } catch (err: any) {
      alert(`Failed to create task: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleComplete = async (task: Task) => {
    const originalTasks = [...tasks];
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, status: 'completed' as const } : t))
    );
    try {
      await api.completeTask(task.id);
    } catch (err: any) {
      setTasks(originalTasks);
      alert(`Network/API failure: rolled back complete action. (${err.message})`);
    }
  };

  const filteredTasks = searchQuery
    ? tasks.filter((t) => t.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : tasks;

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full">
      {/* Header & Quick Add */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-surface-container">
        <div>
          <h1 className="font-sans text-xl font-bold text-on-surface">Tasks & Directives</h1>
          <p className="font-mono text-xs text-outline mt-0.5">Authoritative task state owned exclusively by Cloudflare D1</p>
        </div>

        <form onSubmit={handleCreate} className="flex gap-2 w-full sm:w-auto">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="Add new directive..."
            className="min-h-[44px] bg-surface-container-low border border-surface-container rounded-lg px-3 text-xs font-sans text-on-surface focus:outline-none focus:border-primary flex-1 sm:w-64"
          />
          <button
            type="submit"
            disabled={creating}
            className="min-h-[44px] px-4 bg-primary text-on-primary rounded-lg font-mono text-xs font-semibold shrink-0 disabled:opacity-50"
          >
            {creating ? 'Saving...' : 'Create'}
          </button>
        </form>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-container-lowest p-2.5 rounded-lg border border-surface-container">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setStatusFilter('open')}
            className={`min-h-[44px] px-3.5 py-1.5 rounded-md text-xs font-mono transition-colors ${
              statusFilter === 'open'
                ? 'bg-surface-container text-primary font-bold shadow-sm'
                : 'text-outline hover:text-on-surface'
            }`}
          >
            Open
          </button>
          <button
            onClick={() => setStatusFilter('completed')}
            className={`min-h-[44px] px-3.5 py-1.5 rounded-md text-xs font-mono transition-colors ${
              statusFilter === 'completed'
                ? 'bg-surface-container text-primary font-bold shadow-sm'
                : 'text-outline hover:text-on-surface'
            }`}
          >
            Completed
          </button>
          <button
            onClick={() => setStatusFilter('all')}
            className={`min-h-[44px] px-3.5 py-1.5 rounded-md text-xs font-mono transition-colors ${
              statusFilter === 'all'
                ? 'bg-surface-container text-primary font-bold shadow-sm'
                : 'text-outline hover:text-on-surface'
            }`}
          >
            All
          </button>
        </div>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter tasks..."
          className="min-h-[44px] bg-surface-container-low border border-surface-container rounded-lg px-3 text-xs font-sans text-on-surface focus:outline-none focus:border-primary w-full sm:w-48"
        />
      </div>

      {/* Tasks List */}
      <Card title={`Directives (${filteredTasks.length})`}>
        {loading ? (
          <div className="text-center py-12 font-mono text-xs text-primary animate-pulse">
            Syncing tasks from D1...
          </div>
        ) : error ? (
          <div className="text-center py-8 font-mono text-xs text-error">
            Error: {error}
          </div>
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            title="No tasks match criteria"
            description="Adjust your filters or add a new directive above."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {filteredTasks.map((t) => (
              <EntityRow
                key={t.id}
                id={t.id}
                title={t.title}
                subtitle={t.description || (t.deadline_local_date ? `Deadline: ${t.deadline_local_date}` : undefined)}
                meta={`v${t.deadline_version} · ${t.priority}`}
                priority={t.priority}
                isCompleted={t.status === 'completed'}
                isUrgent={t.priority === 'urgent'}
                statusGlyph={t.status === 'completed' ? 'done' : t.priority === 'urgent' ? 'error' : 'open'}
                onDone={() => handleComplete(t)}
                onDetails={() => onInspectTask(t)}
                onClick={() => onInspectTask(t)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
