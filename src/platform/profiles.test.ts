import { describe, it, expect } from 'vitest';
import { classifyLayout, COMMANDER_MIN_W, COMMANDER_MIN_H, TILE_MAX_H } from './profiles';

describe('classifyLayout', () => {
  it('classifies the four mandated widget sizes', () => {
    expect(classifyLayout(344, 165).mode).toBe('tile');       // Landscape
    expect(classifyLayout(388, 510).mode).toBe('tabbed');     // Portrait
    expect(classifyLayout(720, 510).mode).toBe('commander');  // Expanded
    expect(classifyLayout(1100, 510).mode).toBe('commander'); // XL
  });

  it('classifies side panel and full page', () => {
    expect(classifyLayout(360, 900).mode).toBe('tabbed');     // side panel
    expect(classifyLayout(1440, 900).mode).toBe('commander'); // full page
  });

  it('uses tile only when too short to browse', () => {
    expect(classifyLayout(1100, TILE_MAX_H - 1).mode).toBe('tile');
    expect(classifyLayout(1100, TILE_MAX_H).mode).not.toBe('tile');
  });

  it('needs both min width and min height for commander', () => {
    expect(classifyLayout(COMMANDER_MIN_W - 1, 800).mode).toBe('tabbed');
    expect(classifyLayout(800, COMMANDER_MIN_H - 1).mode).toBe('tabbed');
    expect(classifyLayout(COMMANDER_MIN_W, COMMANDER_MIN_H).mode).toBe('commander');
  });

  it('returns the measured dimensions', () => {
    const l = classifyLayout(720, 510);
    expect(l.width).toBe(720);
    expect(l.height).toBe(510);
  });
});
