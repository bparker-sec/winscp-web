// Container-dimension → layout-mode classification. Pure + unit-tested.
// Fluid: within a mode the app scales continuously; the mode only switches at
// real content thresholds.

export type LayoutMode = 'commander' | 'tabbed' | 'tile';

export interface Layout {
  mode: LayoutMode;
  width: number;
  height: number;
}

// Commander (dual pane) needs enough room for two side-by-side panes + queue.
export const COMMANDER_MIN_W = 640;
export const COMMANDER_MIN_H = 360;
// Below this height there is no room to browse a file list — show status only.
export const TILE_MAX_H = 220;

export function classifyLayout(width: number, height: number): Layout {
  if (height < TILE_MAX_H) return { mode: 'tile', width, height };
  if (width >= COMMANDER_MIN_W && height >= COMMANDER_MIN_H) {
    return { mode: 'commander', width, height };
  }
  return { mode: 'tabbed', width, height };
}
