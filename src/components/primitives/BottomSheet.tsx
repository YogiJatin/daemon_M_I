import React, { useEffect } from 'react';

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}

export const BottomSheet: React.FC<BottomSheetProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm sm:hidden animate-fade-in">
      <div
        className="w-full bg-surface-container-lowest rounded-t-2xl p-space-md max-h-[85vh] overflow-y-auto border-t border-outline-variant shadow-2xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-outline-variant rounded-full mx-auto mb-3" />

        {(title || subtitle) && (
          <div className="flex items-start justify-between mb-4 pb-2 border-b border-surface-container">
            <div>
              {title && <h3 className="font-sans text-base font-semibold text-on-surface">{title}</h3>}
              {subtitle && <p className="font-mono text-xs text-outline mt-0.5">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center font-mono text-sm text-outline hover:text-on-surface"
            >
              ✕
            </button>
          </div>
        )}

        <div>{children}</div>
      </div>
    </div>
  );
};
