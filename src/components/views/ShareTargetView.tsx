import React, { useState, useEffect } from 'react';
import { Card } from '../primitives/Card';
import { api } from '../../api/client';

interface ShareTargetViewProps {
  onSaved: () => void;
  onCancel: () => void;
}

export const ShareTargetView: React.FC<ShareTargetViewProps> = ({ onSaved, onCancel }) => {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    // Read query params passed by Android share target
    const sp = new URLSearchParams(window.location.search);
    const sharedTitle = sp.get('title') || '';
    const sharedText = sp.get('text') || '';
    const sharedUrl = sp.get('url') || '';

    setTitle(sharedTitle);
    setText(sharedText);
    setUrl(sharedUrl);
  }, []);

  const handleConfirm = async () => {
    setIsSaving(true);
    try {
      const combinedTitle = title || text.slice(0, 80) || url || 'Shared Capture';
      const combinedDescription = [title, text, url].filter(Boolean).join('\n\n');

      await api.createTask({
        title: combinedTitle,
        description: combinedDescription,
        priority: 'normal',
      });
      onSaved();
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-lg mx-auto py-6">
      <div className="text-center pb-4 border-b border-surface-container">
        <h2 className="font-sans text-xl font-semibold text-on-surface">Share Target Preview</h2>
        <p className="font-mono text-xs text-outline mt-1">
          Review shared content before persisting to Memory (TEST-4.7)
        </p>
      </div>

      <Card title="Incoming Payload">
        <div className="space-y-4">
          <div>
            <label className="block font-mono text-[11px] uppercase text-outline mb-1">
              Title / Subject
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-surface-container-lowest border border-surface-container rounded px-3 py-2 text-xs font-sans text-on-surface focus:outline-none"
              placeholder="Title..."
            />
          </div>

          <div>
            <label className="block font-mono text-[11px] uppercase text-outline mb-1">
              Shared Text
            </label>
            <textarea
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full bg-surface-container-lowest border border-surface-container rounded px-3 py-2 text-xs font-sans text-on-surface focus:outline-none"
              placeholder="Shared notes..."
            />
          </div>

          {url && (
            <div>
              <label className="block font-mono text-[11px] uppercase text-outline mb-1">
                Shared Link
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full bg-surface-container-lowest border border-surface-container rounded px-3 py-2 text-xs font-mono text-primary focus:outline-none"
              />
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleConfirm}
              disabled={isSaving}
              className="flex-1 min-h-[44px] py-2 px-4 rounded-lg bg-primary hover:bg-primary-container text-on-primary font-mono text-xs font-semibold"
            >
              {isSaving ? 'Persisting...' : 'Confirm & Save to Memory'}
            </button>
            <button
              onClick={onCancel}
              disabled={isSaving}
              className="min-h-[44px] px-4 rounded-lg bg-surface-container hover:bg-surface-container-high font-mono text-xs text-outline"
            >
              Discard
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
};
