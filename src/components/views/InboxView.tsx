import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { Card } from '../primitives/Card';
import { EmptyState } from '../primitives/EmptyState';

interface TaskProposal {
  id: string;
  source_event_id: string | null;
  title: string;
  description: string | null;
  category: string;
  priority: string;
  date_role: string;
  proposed_local_date: string | null;
  proposed_local_time: string | null;
  evidence_quote: string | null;
  ambiguity_reasons: string | null;
  advisory_confidence: number;
  status: 'pending' | 'confirmed' | 'rejected' | 'failed';
  task_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InboxViewProps {
  onTaskCreated?: () => void;
}

export const InboxView: React.FC<InboxViewProps> = ({ onTaskCreated }) => {
  const [proposals, setProposals] = useState<TaskProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'confirmed' | 'rejected'>('pending');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const fetchProposals = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.getProposals(statusFilter);
      setProposals(res.proposals || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load inbox proposals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProposals();
  }, [statusFilter]);

  const handleConfirm = async (proposal: TaskProposal) => {
    setProcessingId(proposal.id);
    setActionMessage(null);
    try {
      await api.confirmProposal(proposal.id);
      setActionMessage(`Approved "${proposal.title}" — Task created in Memory.`);
      if (onTaskCreated) onTaskCreated();
      // Remove or update in list
      setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
    } catch (err: any) {
      setActionMessage(`Approval failed: ${err.message}`);
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (proposal: TaskProposal) => {
    setProcessingId(proposal.id);
    setActionMessage(null);
    try {
      await api.rejectProposal(proposal.id, 'Dismissed from Inbox');
      setActionMessage(`Rejected proposal "${proposal.title}".`);
      setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
    } catch (err: any) {
      setActionMessage(`Rejection failed: ${err.message}`);
    } finally {
      setProcessingId(null);
    }
  };

  const getPriorityBadgeClass = (priority: string) => {
    switch (priority) {
      case 'urgent':
        return 'bg-error-container text-on-error-container border-error/30';
      case 'high':
        return 'bg-warning-container text-on-warning-container border-warning/30';
      case 'normal':
        return 'bg-surface-container text-primary border-primary/20';
      case 'low':
      default:
        return 'bg-surface-container-low text-outline border-outline/20';
    }
  };

  return (
    <div className="flex-1 flex flex-col gap-6 max-w-4xl mx-auto w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-surface-container pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-on-surface flex items-center gap-2">
            <span>📥</span> Inbox & AI Proposals
          </h1>
          <p className="text-xs text-outline font-mono mt-1">
            Governed human-in-the-loop review. Proposals from Voice, OCR, Docs, and AI never mutate tasks without your approval.
          </p>
        </div>

        {/* Status Filter Tabs */}
        <div className="flex items-center gap-1 bg-surface-container-lowest p-1 rounded-lg border border-surface-container self-start">
          {(['pending', 'confirmed', 'rejected'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md text-xs font-mono font-medium capitalize transition-colors ${
                statusFilter === s
                  ? 'bg-surface-container text-primary font-bold shadow-sm'
                  : 'text-outline hover:text-on-surface'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Action Notification */}
      {actionMessage && (
        <div className="px-4 py-3 rounded-lg bg-surface-container border border-primary/20 text-xs font-mono text-primary flex items-center justify-between">
          <span>{actionMessage}</span>
          <button onClick={() => setActionMessage(null)} className="text-outline hover:text-on-surface font-bold">✕</button>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="px-4 py-3 rounded-lg bg-error-container text-on-error-container text-xs font-mono border border-error/30">
          {error}
        </div>
      )}

      {/* Proposals List */}
      <div className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-outline font-mono text-xs">
            Loading proposals...
          </div>
        ) : proposals.length === 0 ? (
          <EmptyState
            title={`No ${statusFilter} proposals`}
            description={
              statusFilter === 'pending'
                ? 'All clear! Ingest voice notes, screenshots, or documents via Ctrl+K to draft new governed proposals.'
                : `No proposals with status "${statusFilter}".`
            }
          />
        ) : (
          proposals.map((proposal) => {
            const isProcessing = processingId === proposal.id;
            return (
              <Card key={proposal.id} className="p-4 sm:p-5 flex flex-col gap-3 border border-surface-container hover:border-primary/40 transition-colors">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${getPriorityBadgeClass(proposal.priority)}`}>
                        {proposal.priority}
                      </span>
                      {proposal.category && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-surface-container-low text-on-surface-variant border border-surface-container">
                          {proposal.category}
                        </span>
                      )}
                      <span className="text-[10px] font-mono text-outline">
                        Confidence: {Math.round((proposal.advisory_confidence || 0) * 100)}%
                      </span>
                    </div>

                    <h3 className="text-sm sm:text-base font-semibold text-on-surface mt-1">
                      {proposal.title}
                    </h3>

                    {proposal.description && (
                      <p className="text-xs text-on-surface-variant leading-relaxed">
                        {proposal.description}
                      </p>
                    )}
                  </div>

                  {/* Actions for Pending */}
                  {statusFilter === 'pending' && (
                    <div className="flex sm:flex-col items-center gap-2 self-end sm:self-auto shrink-0">
                      <button
                        onClick={() => handleConfirm(proposal)}
                        disabled={isProcessing}
                        className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 min-h-[36px] flex items-center gap-1.5"
                      >
                        {isProcessing ? 'Saving...' : '✓ Approve & Create'}
                      </button>
                      <button
                        onClick={() => handleReject(proposal)}
                        disabled={isProcessing}
                        className="px-3 py-1.5 rounded-lg bg-surface-container-low text-error hover:bg-surface-container text-xs font-medium border border-surface-container transition-colors disabled:opacity-50 min-h-[36px]"
                      >
                        ✕ Reject
                      </button>
                    </div>
                  )}
                </div>

                {/* Metadata & Proposed Timing */}
                <div className="pt-3 border-t border-surface-container flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-outline">
                  <div className="flex items-center gap-3">
                    {(proposal.proposed_local_date || proposal.proposed_local_time) && (
                      <span className="flex items-center gap-1 text-on-surface-variant">
                        <span>📅</span>
                        <span>
                          {proposal.date_role ? `${proposal.date_role}: ` : ''}
                          {proposal.proposed_local_date || ''} {proposal.proposed_local_time || ''}
                        </span>
                      </span>
                    )}
                    {proposal.evidence_quote && (
                      <span className="italic truncate max-w-xs" title={proposal.evidence_quote}>
                        "{proposal.evidence_quote}"
                      </span>
                    )}
                  </div>
                  <span>Received: {new Date(proposal.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
};
