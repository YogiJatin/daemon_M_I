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
  const [priorityFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');

  const fetchTasks = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.getTasks({
        status: statusFilter === 'all' ? undefined : statusFilter,
        priority: priorityFilter === 'all' ? undefined : priorityFilter,
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
  }, [statusFilter, priorityFilter]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    try {
      await api.createTask({ title: newTaskTitle.trim(), priority: 'normal' });
      setNewTaskTitle('');
      fetchTasks();
    } catch (err: any) {
      alert(`Failed to create task: ${err.message}`);
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
    <div className="flex flex-col gap-6">
      {/* Header & Quick Add */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-surface-container">
        <div>
          <h2 className="font-sans text-xl font-semibold text-on-surface">Memory (Tasks & Directives)</h2>
          <p className="font-mono text-xs text-outline mt-0.5">Authoritative state owned exclusively by D1</p>
        </div>

        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="Add new directive..."
            className="bg-surface-container-low border border-surface-container rounded-lg px-3 py-1.5 text-xs font-sans text-on-surface focus:outline-none focus:border-primary w-48 sm:w-64"
          />
          <button
            type="submit"
            className="min-h-[44px] sm:min-h-[32px] px-3 bg-primary text-on-primary rounded-lg font-mono text-xs font-medium"
          >
            Create
          </button>
        </form>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-container-lowest p-2.5 rounded-lg border border-surface-container">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setStatusFilter('open')}
            className={`min-h-[44px] sm:min-h-[28px] px-3 py-1 rounded text-xs font-mono transition-colors ${
              statusFilter === 'open'
                ? 'bg-surface-container text-primary font-semibold'
                : 'text-outline hover:text-on-surface'
            }`}
          >
            Open
          </button>
          <button
            onClick={() => setStatusFilter('completed')}
            className={`min-h-[44px] sm:min-h-[28px] px-3 py-1 rounded text-xs font-mono transition-colors ${
              statusFilter === 'completed'
                ? 'bg-surface-container text-primary font-semibold'
                : 'text-outline hover:text-on-surface'
            }`}
          >
            Completed
          </button>
          <button
            onClick={() => setStatusFilter('all')}
            className={`min-h-[44px] sm:min-h-[28px] px-3 py-1 rounded text-xs font-mono transition-colors ${
              statusFilter === 'all'
                ? 'bg-surface-container text-primary font-semibold'
                : 'text-outline hover:text-on-surface'
            }`}
          >
            All
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter Memory..."
            className="bg-surface-container-low border border-surface-container rounded px-2.5 py-1 text-xs font-sans text-on-surface focus:outline-none w-36 sm:w-44"
          />
        </div>
      </div>

      {/* Tasks List */}
      <Card title={`Active Directives (${filteredTasks.length})`}>
        {loading ? (
          <div className="text-center py-10 font-mono text-xs text-primary animate-pulse">
            Syncing memory from D1...
          </div>
        ) : error ? (
          <div className="text-center py-8 font-mono text-xs text-error">
            Error: {error}
          </div>
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            title="No tasks match criteria"
            description="Adjust your filters or add a new task."
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
