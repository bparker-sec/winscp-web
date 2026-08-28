import { useEffect, type ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className="bg-surface border border-border rounded-lg shadow-xl w-[min(92vw,420px)] max-h-[90vh] overflow-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 border-b border-border font-semibold">{title}</div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
