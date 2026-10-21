import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';
import { StatusGlyph } from '../primitives/StatusGlyph';

interface MemoryInspectorContentProps {
  memoryId: string;
  onClose: () => void;
  onSelectRelated?: (id: string) => void;
}

export const MemoryInspectorContent: React.FC<MemoryInspectorContentProps> = ({
  memoryId,
  onClose: _onClose,
  onSelectRelated,
}) => {
  const [data, setData] = useState<any>(null);
  const [relationships, setRelationships] = useState<any[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'details' | 'graph' | 'timeline'>('details');

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);

    Promise.all([
      api.getMemoryById(memoryId),
      api.getMemoryRelationships(memoryId, 'both'),
      api.getMemoryTimeline(memoryId),
    ])
      .then(([memData, relData, timeData]) => {
        if (!isMounted) return;
        setData(memData);
        setRelationships(relData.relationships || []);
        setTimeline(timeData.timeline || []);
      })
      .catch((err) => {
        console.error('Failed to load memory inspector data:', err);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [memoryId]);

  if (isLoading) {
    return (
      <div className="py-12 flex flex-col items-center justify-center space-y-3 font-mono text-xs text-outline">
        <StatusGlyph status="loading" />
        <span>Hydrating canonical memory...</span>
      </div>
    );
  }

  if (!data?.object) {
    return (
      <div className="py-8 text-center font-mono text-xs text-error">
        Memory object not found or unavailable.
      </div>
    );
  }

  const obj = data.object;

  return (
    <div className="space-y-4">
      {/* Tab Switcher */}
      <div className="flex border-b border-surface-container font-mono text-xs">
        <button
          onClick={() => setActiveTab('details')}
          className={`px-3 py-2 border-b-2 font-medium transition-colors ${
            activeTab === 'details'
              ? 'border-primary text-primary'
              : 'border-transparent text-outline hover:text-on-surface'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('graph')}
          className={`px-3 py-2 border-b-2 font-medium transition-colors ${
            activeTab === 'graph'
              ? 'border-primary text-primary'
              : 'border-transparent text-outline hover:text-on-surface'
          }`}
        >
          Graph ({relationships.length})
        </button>
        <button
          onClick={() => setActiveTab('timeline')}
          className={`px-3 py-2 border-b-2 font-medium transition-colors ${
            activeTab === 'timeline'
              ? 'border-primary text-primary'
              : 'border-transparent text-outline hover:text-on-surface'
          }`}
        >
          Timeline ({timeline.length})
        </button>
      </div>

      {activeTab === 'details' && (
        <div className="space-y-4 animate-fade-in">
          {/* Metadata Cards */}
          <div className="p-3 rounded-lg bg-surface-container-low border border-surface-container space-y-2 font-mono text-xs">
            <div className="flex justify-between">
              <span className="text-outline">Type:</span>
              <span className="text-primary uppercase font-medium">{obj.type}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-outline">Source:</span>
              <span className="text-on-surface">{obj.source}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-outline">ID:</span>
              <span className="text-on-surface text-[10px] select-all">{obj.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-outline">Ingested:</span>
              <span className="text-outline">{obj.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
          </div>

          {/* Executive Summary */}
          {obj.summary && (
            <div className="p-3 rounded-lg bg-surface-container-low border border-surface-container space-y-1">
              <div className="font-mono text-[10px] text-tertiary uppercase tracking-wider font-semibold">
                ✦ Executive Summary
              </div>
              <p className="font-sans text-xs text-on-surface leading-relaxed">{obj.summary}</p>
            </div>
          )}

          {/* Canonical Content Excerpt */}
          <div className="space-y-1">
            <div className="font-mono text-[10px] text-outline uppercase tracking-wider font-semibold">
              Canonical Text
            </div>
            <div className="p-3 rounded-lg bg-surface-container-lowest border border-surface-container max-h-48 overflow-y-auto font-sans text-xs text-on-surface-variant leading-relaxed select-text whitespace-pre-wrap">
              {obj.canonicalText}
            </div>
          </div>

          {/* Tags */}
          {data.tags && data.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {data.tags.map((t: string) => (
                <span
                  key={t}
                  className="px-2 py-0.5 rounded font-mono text-[10px] bg-surface-container text-outline"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'graph' && (
        <div className="space-y-3 animate-fade-in">
          <div className="font-mono text-[10px] text-outline uppercase tracking-wider">
            Connected Knowledge Nodes
          </div>
          {relationships.length === 0 ? (
            <div className="py-6 text-center font-mono text-xs text-outline">
              No relationships linked yet.
            </div>
          ) : (
            <div className="space-y-2">
              {relationships.map((rel: any) => {
                const target = rel.targetObject;
                return (
                  <div
                    key={rel.id}
                    onClick={() => target?.id && onSelectRelated && onSelectRelated(target.id)}
                    className="p-2.5 rounded-lg bg-surface-container-low border border-surface-container hover:bg-surface-container cursor-pointer transition-colors space-y-1"
                  >
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span className="text-tertiary font-medium">
                        {rel.relationshipType.replace('_', ' ')}
                      </span>
                      <span className="text-outline text-[10px]">
                        {Math.round(rel.confidence * 100)}% conf
                      </span>
                    </div>
                    {target && (
                      <div className="font-sans text-xs text-on-surface font-medium truncate">
                        {target.title}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'timeline' && (
        <div className="space-y-3 animate-fade-in">
          <div className="font-mono text-[10px] text-outline uppercase tracking-wider">
            Knowledge Understanding Evolution
          </div>
          {timeline.length === 0 ? (
            <div className="py-6 text-center font-mono text-xs text-outline">
              No timeline events recorded.
            </div>
          ) : (
            <div className="relative pl-4 space-y-4 border-l border-surface-container">
              {timeline.map((evt: any) => (
                <div key={evt.id} className="relative space-y-0.5">
                  <div className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full bg-primary border-2 border-surface-container-lowest" />
                  <div className="font-mono text-[10px] text-outline">
                    {evt.timestamp.slice(0, 16).replace('T', ' ')}
                  </div>
                  <p className="font-sans text-xs text-on-surface">{evt.description}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
