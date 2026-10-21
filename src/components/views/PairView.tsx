import React, { useState } from 'react';
import { Card } from '../primitives/Card';
import { StatusGlyph } from '../primitives/StatusGlyph';
import { api } from '../../api/client';

interface PairViewProps {
  isAuthenticated: boolean;
  onPairedSuccess: () => void;
}

export const PairView: React.FC<PairViewProps> = ({
  isAuthenticated,
  onPairedSuccess,
}) => {
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handlePair = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || code.trim().length !== 6) {
      setError('Pairing code must be exactly 6 characters.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await api.pair(code.trim());
      if (res.authenticated) {
        setSuccessMsg('Device successfully paired. Session active.');
        setCode('');
        setTimeout(() => {
          onPairedSuccess();
        }, 800);
      }
    } catch (err: any) {
      setError(err.message || 'Invalid or expired pairing code.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
      window.location.reload();
    } catch (err: any) {
      alert(`Logout error: ${err.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-lg mx-auto py-6">
      <div className="text-center pb-4 border-b border-surface-container">
        <h2 className="font-sans text-xl font-semibold text-on-surface">Device Pairing Gate</h2>
        <p className="font-mono text-xs text-outline mt-1">
          Cryptographically links this browser / PWA to your Telegram Bot
        </p>
      </div>

      <Card title="Pairing Challenge" badge={<StatusGlyph status={isAuthenticated ? 'healthy' : 'paused'} />}>
        {isAuthenticated ? (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-surface-container-lowest border border-ok/40 flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-ok" />
              <div className="text-xs">
                <div className="font-semibold text-on-surface">This device is authenticated</div>
                <div className="font-mono text-[11px] text-outline">Session bound to Cloudflare D1</div>
              </div>
            </div>

            <button
              onClick={handleLogout}
              className="w-full min-h-[44px] py-2 px-4 rounded-lg bg-surface-container hover:bg-surface-container-high border border-surface-container font-mono text-xs text-error transition-colors"
            >
              Revoke Session & Unpair
            </button>
          </div>
        ) : (
          <form onSubmit={handlePair} className="space-y-4">
            <div className="text-xs font-sans text-outline leading-relaxed">
              To pair this device:
              <ol className="list-decimal list-inside font-mono text-[11px] mt-2 space-y-1 text-on-surface-variant">
                <li>Open your Telegram bot</li>
                <li>Send the command <code className="text-primary font-bold">/pair</code></li>
                <li>Enter the 6-character single-use code below</li>
              </ol>
            </div>

            {error && (
              <div className="p-2.5 rounded bg-surface-container-lowest border border-error/50 font-mono text-xs text-error">
                {error}
              </div>
            )}

            {successMsg && (
              <div className="p-2.5 rounded bg-surface-container-lowest border border-ok/50 font-mono text-xs text-ok">
                {successMsg}
              </div>
            )}

            <div>
              <label className="block font-mono text-xs uppercase text-outline mb-1">
                6-Character Pairing Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="E.g. A3F9B2"
                maxLength={6}
                className="w-full bg-surface-container-lowest border border-surface-container rounded-lg px-4 py-2.5 font-mono text-center text-lg tracking-widest text-primary focus:outline-none focus:border-primary"
                disabled={isSubmitting}
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || code.trim().length !== 6}
              className="w-full min-h-[44px] py-2 px-4 rounded-lg bg-primary hover:bg-primary-container text-on-primary font-mono text-xs font-semibold transition-colors disabled:opacity-50"
            >
              {isSubmitting ? 'Authenticating...' : 'Authenticate Device'}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
};
