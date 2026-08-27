type P = { className?: string };
const S = (d: string) => (p: P) =>
  (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={p.className}>
      <path d={d} />
    </svg>
  );

export const IconFolder = S('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
export const IconFile = S('M6 2h8l4 4v16H6z M14 2v4h4');
export const IconRefresh = S('M21 12a9 9 0 1 1-3-6.7L21 8 M21 4v4h-4');
export const IconUp = S('M12 19V5 M5 12l7-7 7 7');
export const IconDown = S('M12 5v14 M19 12l-7 7-7-7');
export const IconSun = S('M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M19 5l-1.5 1.5 M6.5 17.5 5 19 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z');
export const IconMoon = S('M21 12.8A8 8 0 1 1 11.2 3 6 6 0 0 0 21 12.8z');
export const IconNewFolder = S('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 11v4 M10 13h4');
export const IconTrash = S('M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13');
