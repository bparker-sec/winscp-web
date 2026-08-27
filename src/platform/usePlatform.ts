import { useEffect, useState } from 'react';
import { classifyLayout, type Layout } from './profiles';

function currentSize(): { w: number; h: number } {
  return {
    w: window.innerWidth || document.documentElement.clientWidth,
    h: window.innerHeight || document.documentElement.clientHeight,
  };
}

/** Reactively classify the hosting context, re-evaluating on resize. */
export function usePlatform(): Layout {
  const [layout, setLayout] = useState<Layout>(() => {
    const { w, h } = currentSize();
    return classifyLayout(w, h);
  });

  useEffect(() => {
    const measure = () => {
      const { w, h } = currentSize();
      setLayout((prev) => {
        const next = classifyLayout(w, h);
        if (prev.mode === next.mode && prev.width === next.width && prev.height === next.height) {
          return prev;
        }
        return next;
      });
    };
    measure();
    // The host container can settle to its real size a few frames after mount
    // without firing a resize event, so re-measure across the next frame and
    // a few short delays to catch the final size.
    const raf = requestAnimationFrame(measure);
    const timers = [
      window.setTimeout(measure, 120),
      window.setTimeout(measure, 400),
      window.setTimeout(measure, 1200),
    ];
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(document.documentElement);
    }
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);

  return layout;
}
