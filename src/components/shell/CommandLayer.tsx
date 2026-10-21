import React, { useState, useEffect, useRef } from 'react';
import type { OSMode } from '../../api/types';
import { api } from '../../api/client';

interface CommandLayerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectMode: (mode: OSMode) => void;
  onTaskCreated?: () => void;
}

export const CommandLayer: React.FC<CommandLayerProps> = ({
  isOpen,
  onClose,
  onSelectMode,
  onTaskCreated,
}) => {
  const [query, setQuery] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setFeedback(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        onClose();
      }
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const quickCommands = [
    { label: 'Capture Task / Note', action: () => handleCapture(query), shortcut: 'Enter' },
    { label: 'Focus Mode (Today)', action: () => { onSelectMode('focus'); onClose(); } },
    { label: 'Memory (All Tasks)', action: () => { onSelectMode('memory'); onClose(); } },
    { label: 'Academy (Timetable)', action: () => { onSelectMode('academy'); onClose(); } },
    { label: 'Timeline (Audit History)', action: () => { onSelectMode('timeline'); onClose(); } },
    { label: 'System Health', action: () => { onSelectMode('system'); onClose(); } },
    { label: 'Settings', action: () => { onSelectMode('settings'); onClose(); } },
    { label: 'Pair Telegram Device', action: () => { onSelectMode('pairing'); onClose(); } },
  ];

  const filteredCommands = query
    ? quickCommands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : quickCommands;

  const handleCapture = async (text: string) => {
    const title = text.trim();
    if (!title) return;
    setIsSubmitting(true);
    setFeedback(null);
    try {
      await api.createTask({ title, priority: 'normal' });
      setFeedback('Task recorded to Memory.');
      setQuery('');
      if (onTaskCreated) onTaskCreated();
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      setFeedback(`Failed: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    const matched = quickCommands.find((c) => c.label.toLowerCase() === query.trim().toLowerCase());
    if (matched) {
      matched.action();
      return;
    }

    handleCapture(query);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 px-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-surface-container-lowest border border-outline-variant/40 rounded-xl shadow-2xl overflow-hidden animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="flex items-center px-4 py-3 border-b border-surface-container">
          <span className="font-mono text-primary text-sm mr-3">❯</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or task (e.g. 'Lab report by Friday', 'search', 'health')..."
            className="flex-1 bg-transparent text-on-surface font-sans text-sm focus:outline-none placeholder:text-outline"
            disabled={isSubmitting}
          />
          <kbd className="font-mono text-[10px] text-outline px-1.5 py-0.5 rounded bg-surface-container ml-2">
            ESC
          </kbd>
        </form>

        {feedback && (
          <div className="px-4 py-2 bg-surface-container-low font-mono text-xs text-ok border-b border-surface-container">
            {feedback}
          </div>
        )}

        <div className="max-h-72 overflow-y-auto py-2">
          {query.trim() && (
            <div
              onClick={() => handleCapture(query)}
              className="px-4 py-2.5 mx-2 rounded-lg hover:bg-surface-container flex items-center justify-between cursor-pointer group"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-primary">+</span>
                <span className="font-sans text-xs text-on-surface font-medium">
                  Create task: <span className="text-primary italic">"{query}"</span>
                </span>
              </div>
              <span className="font-mono text-[10px] text-outline group-hover:text-on-surface">
                Press Enter ↵
              </span>
            </div>
          )}

          <div className="px-4 py-1 text-[10px] font-mono uppercase tracking-wider text-outline">
            OS Navigation & Shortcuts
          </div>

          {filteredCommands.map((cmd, idx) => (
            <div
              key={idx}
              onClick={cmd.action}
              className="px-4 py-2.5 mx-2 rounded-lg hover:bg-surface-container flex items-center justify-between cursor-pointer text-on-surface-variant hover:text-on-surface transition-colors"
            >
              <span className="font-sans text-xs">{cmd.label}</span>
              {cmd.shortcut && (
                <span className="font-mono text-[10px] text-outline">
                  {cmd.shortcut}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
