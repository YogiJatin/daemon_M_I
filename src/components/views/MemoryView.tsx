import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { Card } from '../primitives/Card';
import { EmptyState } from '../primitives/EmptyState';

interface MemoryObject {
  id: string;
  type: string;
  title: string;
  canonical_text: string;
  summary?: string | null;
  source: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
}

export const MemoryView: React.FC = () => {
  const [memories, setMemories] = useState<MemoryObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newType, setNewType] = useState('fact');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const fetchMemories = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.getMemory({
        type: typeFilter === 'all' ? undefined : typeFilter,
        limit: 50,
      });
      setMemories(res.objects || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load memory objects');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMemories();
  }, [typeFilter]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    try {
      setSaving(true);
      setFeedback(null);
      const res = await fetch('/api/v1/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTitle.trim(),
          canonicalText: newContent.trim(),
          type: newType,
          source: 'manual',
          tags: [newType],
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error?.message || 'Failed to save memory');
      }
      setFeedback('Memory saved to D1.');
      setNewTitle('');
      setNewContent('');
      setIsAdding(false);
      fetchMemories();
    } catch (err: any) {
      setFeedback(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const filteredMemories = searchQuery
    ? memories.filter(
        (m) =>
          m.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.canonical_text.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : memories;

  return (
    <div className="flex-1 flex flex-col gap-6 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-surface-container pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-on-surface flex items-center gap-2">
            <span>🧠</span> Memory & Knowledge
          </h1>
          <p className="text-xs text-outline font-mono mt-1">
            Authoritative context, user preferences, and private facts owned exclusively by D1.
          </p>
        </div>

        <button
          onClick={() => setIsAdding((v) => !v)}
          className="min-h-[44px] px-4 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-90 transition-opacity self-start sm:self-auto flex items-center gap-1.5"
        >
          {isAdding ? '✕ Cancel' : '+ Add Memory'}
        </button>
      </div>

      {/* Add Memory Form */}
      {isAdding && (
        <form onSubmit={handleCreate} className="p-4 rounded-xl bg-surface-container-low border border-surface-container flex flex-col gap-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Memory title (e.g., Preferred Coffee Spot)"
              className="flex-1 min-h-[44px] bg-surface-container-lowest border border-surface-container rounded-lg px-3 text-xs font-sans text-on-surface focus:outline-none focus:border-primary"
              required
            />
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="min-h-[44px] bg-surface-container-lowest border border-surface-container rounded-lg px-3 text-xs font-mono text-on-surface focus:outline-none focus:border-primary"
            >
              <option value="fact">Fact</option>
              <option value="preference">Preference</option>
              <option value="note">Note</option>
              <option value="document">Document</option>
            </select>
          </div>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Details or canonical text (e.g., Prefers oat milk cappuccino at Blue Tokai)..."
            rows={3}
            className="w-full bg-surface-container-lowest border border-surface-container rounded-lg p-3 text-xs font-sans text-on-surface focus:outline-none focus:border-primary"
            required
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="min-h-[44px] px-3 rounded-lg text-xs font-mono text-outline hover:text-on-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="min-h-[44px] px-5 rounded-lg bg-primary text-on-primary text-xs font-semibold disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Memory'}
            </button>
          </div>
        </form>
      )}

      {/* Feedback Message */}
      {feedback && (
        <div className="px-4 py-3 rounded-lg bg-surface-container border border-primary/20 text-xs font-mono text-primary flex items-center justify-between">
          <span>{feedback}</span>
          <button onClick={() => setFeedback(null)} className="text-outline hover:text-on-surface font-bold">✕</button>
        </div>
      )}

      {/* Search and Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-container-lowest p-2.5 rounded-lg border border-surface-container">
        <div className="flex flex-wrap items-center gap-1.5">
          {['all', 'fact', 'preference', 'note', 'document'].map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`min-h-[44px] px-3 py-1 rounded text-xs font-mono uppercase transition-colors ${
                typeFilter === t
                  ? 'bg-surface-container text-primary font-bold shadow-sm'
                  : 'text-outline hover:text-on-surface'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search memories..."
          className="min-h-[44px] bg-surface-container-low border border-surface-container rounded-lg px-3 text-xs font-sans text-on-surface focus:outline-none focus:border-primary w-full sm:w-56"
        />
      </div>

      {/* Memory List */}
      <div className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-outline font-mono text-xs">
            Loading memory objects from D1...
          </div>
        ) : error ? (
          <div className="p-4 rounded-lg bg-error-container text-on-error-container font-mono text-xs border border-error/30">
            Error: {error}
          </div>
        ) : filteredMemories.length === 0 ? (
          <EmptyState
            title={`No ${typeFilter === 'all' ? '' : typeFilter + ' '}memories found`}
            description="Stored facts and preferences appear here. Use Telegram /remember or click '+ Add Memory'."
          />
        ) : (
          filteredMemories.map((m) => (
            <Card key={m.id} className="p-4 flex flex-col gap-2 border border-surface-container hover:border-primary/30 transition-colors">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-primary/10 text-primary border border-primary/20">
                    {m.type}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-surface-container text-outline border border-surface-container">
                    source: {m.source}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-outline">
                  {new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </div>

              <h3 className="font-semibold text-sm text-on-surface mt-1">
                {m.title}
              </h3>

              <p className="text-xs text-on-surface-variant leading-relaxed whitespace-pre-wrap">
                {m.canonical_text}
              </p>

              {m.summary && m.summary !== m.canonical_text && (
                <div className="mt-1 p-2 rounded bg-surface-container-lowest border border-surface-container text-[11px] text-outline font-mono">
                  Summary: {m.summary}
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
};
