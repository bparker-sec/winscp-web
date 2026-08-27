import { useEffect, useState } from 'react';

interface Props {
  ratio: number; // 0..1 width fraction of the left pane
  onRatio: (r: number) => void;
}

export function Splitter({ ratio, onRatio }: Props) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const r = Math.min(0.8, Math.max(0.2, e.clientX / window.innerWidth));
      onRatio(r);
    };
    const stop = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop); // end the drag if the mouseup is lost off-window
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
    };
  }, [dragging, onRatio]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={() => setDragging(true)}
      title={`${Math.round(ratio * 100)}%`}
      className={`w-1 cursor-col-resize transition-colors ${
        dragging ? 'bg-accent' : 'bg-border hover:bg-accent'
      }`}
    />
  );
}
