import { useCallback, useRef } from 'react';

interface Props {
  ratio: number; // 0..1 width fraction of the left pane
  onRatio: (r: number) => void;
}

export function Splitter({ ratio, onRatio }: Props) {
  const dragging = useRef(false);

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return;
      const r = Math.min(0.8, Math.max(0.2, e.clientX / window.innerWidth));
      onRatio(r);
    },
    [onRatio],
  );

  const onUp = useCallback(() => {
    dragging.current = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }, [onMove]);

  const onDown = useCallback(() => {
    dragging.current = true;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [onMove, onUp]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onDown}
      title={`${Math.round(ratio * 100)}%`}
      className="w-1 cursor-col-resize bg-border hover:bg-accent transition-colors"
    />
  );
}
