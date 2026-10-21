import React, { useState } from 'react';
import { api } from '../../api/client';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCaptureComplete?: (result: any) => void;
}

export const CameraCaptureModal: React.FC<CameraCaptureModalProps> = ({
  isOpen,
  onClose,
  onCaptureComplete,
}) => {
  const [mode, setMode] = useState<'still' | 'document' | 'whiteboard'>('still');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCapture = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.captureCamera(mode, true, `Camera snapshot (${mode})`);
      setSuccess(`Captured! Attachment ID: ${res.capture.attachmentId}`);
      if (onCaptureComplete) onCaptureComplete(res.capture);
    } catch (err: any) {
      setError(err.message || 'Capture failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card border border-border rounded-lg max-w-md w-full p-5 space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <h3 className="text-base font-semibold text-foreground">Camera Snapshot</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">
            ✕
          </button>
        </div>

        {error && <div className="p-2 text-xs rounded bg-destructive/15 text-destructive">{error}</div>}
        {success && <div className="p-2 text-xs rounded bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">{success}</div>}

        <div className="space-y-2">
          <label className="text-xs font-medium text-foreground">Capture Mode</label>
          <div className="grid grid-cols-3 gap-2">
            {(['still', 'document', 'whiteboard'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`py-1.5 text-xs rounded border text-center font-medium capitalize transition-colors ${
                  mode === m
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="p-8 border border-dashed border-border rounded bg-muted/20 flex flex-col items-center justify-center text-center space-y-2">
          <span className="text-2xl">📷</span>
          <p className="text-xs text-muted-foreground">Permission-gated camera snapshot surface</p>
        </div>

        <div className="flex justify-end space-x-2 pt-2 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border hover:bg-muted text-foreground"
          >
            Close
          </button>
          <button
            onClick={handleCapture}
            disabled={loading}
            className="px-4 py-1.5 text-xs font-semibold rounded bg-primary text-primary-foreground hover:opacity-90"
          >
            {loading ? 'Capturing...' : 'Capture Snapshot'}
          </button>
        </div>
      </div>
    </div>
  );
};
