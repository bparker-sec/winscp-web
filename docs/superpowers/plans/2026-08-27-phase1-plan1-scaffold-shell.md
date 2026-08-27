# WinSCP Web — Plan 1: Scaffold & Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a static-only Vite + React + TS + Tailwind PWA that classifies its hosting
context by measured size and renders the WinSCP-style thick-app shell in all three layout modes
(Commander / Tabbed / Tile), in light and dark, against a mock filesystem.

**Architecture:** Pure client-side SPA. A `platform` module maps measured container size to a
`LayoutMode`; `App` switches on it. A `theme` module provides light/dark tokens persisted to
localStorage. The shell (menu bar, toolbar, status bar, panes, splitter, queue) renders from a
`FileSystem` interface backed by an in-memory `MockFS` so the UI is exercisable before any real
protocol exists.

**Tech Stack:** Vite 5, React 18, TypeScript 5, Tailwind 3, vite-plugin-pwa, Vitest + jsdom.

---

## File Structure

- `package.json`, `package-lock.json` — deps + committed lockfile
- `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json` — TS project refs
- `vite.config.ts` — static build + PWA plugin
- `postcss.config.js`, `tailwind.config.js` — Tailwind
- `index.html` — SPA entry
- `src/main.tsx` — React bootstrap
- `src/index.css` — Tailwind layers + CSS variable theme
- `src/App.tsx` — layout-mode switch
- `src/platform/profiles.ts` + `profiles.test.ts` — fluid size → `LayoutMode` (pure, tested)
- `src/platform/usePlatform.ts` — reactive classification hook
- `src/theme/theme.ts` + `theme.test.ts` — theme load/save/system (pure, tested)
- `src/theme/useTheme.ts` — theme hook + `<html>` attribute application
- `src/fs/FileSystem.ts` — the `FileSystem`/`FsEntry` interface (types only)
- `src/fs/MockFS.ts` + `MockFS.test.ts` — in-memory filesystem for the shell
- `src/state/AppProvider.tsx` — minimal app context (theme, mock local/remote FS)
- `src/ui/MenuBar.tsx`, `Toolbar.tsx`, `StatusBar.tsx`, `Splitter.tsx`, `PaneView.tsx`, `TransferQueue.tsx`, `icons.tsx`
- `src/layouts/Commander.tsx`, `TabbedSingle.tsx`, `StatusTile.tsx`
- `public/favicon.svg`, `public/pwa-192.png`, `public/pwa-512.png` — PWA assets

---

## Task 1: Project manifest and lockfile

**Files:**
- Create: `package.json`
- Create: `package-lock.json` (generated)

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "winscp-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "WinSCP Web — a client-side PWA SFTP/file-transfer client that uses OneDrive as the local side, delivered for the Island browser via the AI app host.",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -b --noEmit",
    "lock": "npm install --package-lock-only --ignore-scripts --no-audit"
  },
  "dependencies": {
    "ai-publish-sdk": "^1.9.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@noble/hashes": "^1.5.0",
    "@noble/curves": "^1.6.0",
    "@noble/ciphers": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vite-plugin-pwa": "^0.21.1",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Generate the lockfile**

Run: `npm install --package-lock-only --ignore-scripts --no-audit`
Expected: `package-lock.json` created, no error. (The `@noble/*` and other versions resolve; if a
listed version is unavailable npm picks the nearest satisfying it and writes exact versions to the
lock.)

- [ ] **Step 3: Install for local dev/test**

Run: `npm install --ignore-scripts --no-audit`
Expected: `node_modules/` populated; exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: project manifest and lockfile"
```

---

## Task 2: TypeScript + Vite + Tailwind config (static, PWA)

**Files:**
- Create: `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`
- Create: `vite.config.ts`, `postcss.config.js`, `tailwind.config.js`
- Create: `index.html`

- [ ] **Step 1: Write `tsconfig.json`**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

- [ ] **Step 2: Write `tsconfig.app.json`**

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "useDefineForClassFields": true,
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "noEmit": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 4: Write `vite.config.ts`** (static SPA + PWA, no SSR/edge)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'WinSCP Web',
        short_name: 'WinSCP Web',
        description: 'SFTP / file transfer client with OneDrive as the local side.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/graph\.microsoft\.com\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  build: { target: 'es2021', outDir: 'dist', sourcemap: false },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 5: Write `postcss.config.js`**

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 6: Write `tailwind.config.js`** (class-driven dark mode; CSS variables carry the palette)

```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        border: 'var(--border)',
        text: 'var(--text)',
        muted: 'var(--muted)',
        accent: 'var(--accent)',
        'accent-fg': 'var(--accent-fg)',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 7: Write `index.html`**

```html
<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>WinSCP Web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Commit**

```bash
git add tsconfig*.json vite.config.ts postcss.config.js tailwind.config.js index.html
git commit -m "chore: vite + typescript + tailwind + pwa config (static build)"
```

---

## Task 3: Fluid platform classifier (TDD)

**Files:**
- Create: `src/platform/profiles.ts`
- Test: `src/platform/profiles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/profiles.test.ts`
Expected: FAIL — cannot find module `./profiles`.

- [ ] **Step 3: Write `src/platform/profiles.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/profiles.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/profiles.ts src/platform/profiles.test.ts
git commit -m "feat: fluid layout-mode classifier"
```

---

## Task 4: Reactive platform hook

**Files:**
- Create: `src/platform/usePlatform.ts`

- [ ] **Step 1: Write `src/platform/usePlatform.ts`** (adapted from notepad++ pattern)

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no errors (note: App.tsx does not exist yet; if `tsc -b` complains about unrelated missing
files, defer this check to Task 11 Step 2 where the full tree exists). If it errors only because
there is no entry using this hook, that is fine — proceed.

- [ ] **Step 3: Commit**

```bash
git add src/platform/usePlatform.ts
git commit -m "feat: reactive platform hook"
```

---

## Task 5: Theme module (TDD)

**Files:**
- Create: `src/theme/theme.ts`
- Test: `src/theme/theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadTheme, saveTheme, THEME_KEY, type Theme } from './theme';

describe('theme persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a saved theme', () => {
    saveTheme('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(loadTheme('light')).toBe('dark');
  });

  it('falls back to the provided system default when nothing is saved', () => {
    expect(loadTheme('dark')).toBe('dark');
    expect(loadTheme('light')).toBe('light');
  });

  it('ignores a corrupt stored value', () => {
    localStorage.setItem(THEME_KEY, 'chartreuse');
    expect(loadTheme('light')).toBe('light');
  });

  it('does not throw if localStorage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => saveTheme('dark' as Theme)).not.toThrow();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/theme/theme.test.ts`
Expected: FAIL — cannot find module `./theme`.

- [ ] **Step 3: Write `src/theme/theme.ts`**

```ts
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'winscp-theme';

/** The OS/browser preference, defaulting to light when unknown. */
export function systemTheme(): Theme {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Load the saved theme, falling back to `fallback` when absent/corrupt. */
export function loadTheme(fallback: Theme): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Persist the theme choice; never throws. */
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/theme/theme.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/theme/theme.ts src/theme/theme.test.ts
git commit -m "feat: theme load/save with safe fallbacks"
```

---

## Task 6: Theme hook (applies `data-theme` to `<html>`)

**Files:**
- Create: `src/theme/useTheme.ts`

- [ ] **Step 1: Write `src/theme/useTheme.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';
import { loadTheme, saveTheme, systemTheme, type Theme } from './theme';

export interface ThemeApi {
  theme: Theme;
  toggle: () => void;
  set: (t: Theme) => void;
}

export function useTheme(): ThemeApi {
  const [theme, setThemeState] = useState<Theme>(() => loadTheme(systemTheme()));

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const set = useCallback((t: Theme) => {
    setThemeState(t);
    saveTheme(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      saveTheme(next);
      return next;
    });
  }, []);

  return { theme, toggle, set };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/theme/useTheme.ts
git commit -m "feat: theme hook applies data-theme attribute"
```

---

## Task 7: FileSystem interface + MockFS (TDD)

**Files:**
- Create: `src/fs/FileSystem.ts`
- Create: `src/fs/MockFS.ts`
- Test: `src/fs/MockFS.test.ts`

- [ ] **Step 1: Write `src/fs/FileSystem.ts`** (types only — the seam future protocols implement)

```ts
export type FsKind = 'onedrive' | 'sftp' | 'mock';

export interface FsEntry {
  name: string;
  path: string; // POSIX-style absolute path within this filesystem
  kind: 'file' | 'dir' | 'symlink';
  size?: number;
  mtime?: number; // epoch ms
  mode?: number; // POSIX permission bits when known
  owner?: string;
  group?: string;
  raw?: unknown;
}

export interface ReadHandle {
  read(into: Uint8Array): Promise<number>; // bytes read; 0 at EOF
  close(): Promise<void>;
  size?: number;
}

export interface WriteHandle {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileSystem {
  readonly kind: FsKind;
  readonly label: string; // shown in the pane header, e.g. "OneDrive" or "deploy@host"
  list(path: string): Promise<FsEntry[]>;
  stat(path: string): Promise<FsEntry>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  move(from: string, to: string): Promise<void>;
  openRead(path: string): Promise<ReadHandle>;
  openWrite(path: string, size?: number): Promise<WriteHandle>;
  chmod?(path: string, mode: number): Promise<void>;
}

/** Folders first, then files, each case-insensitively alphabetical. */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const af = a.kind === 'dir' ? 0 : 1;
    const bf = b.kind === 'dir' ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** Join a POSIX dir + name into a normalized absolute path. */
export function joinPath(dir: string, name: string): string {
  if (dir === '/' || dir === '') return `/${name}`;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

/** Parent of a POSIX path ("/a/b" → "/a", "/a" → "/"). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { joinPath, parentPath, sortEntries, type FsEntry } from './FileSystem';
import { MockFS } from './MockFS';

describe('path helpers', () => {
  it('joins paths', () => {
    expect(joinPath('/', 'a')).toBe('/a');
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(joinPath('/a/', 'b')).toBe('/a/b');
  });
  it('finds parents', () => {
    expect(parentPath('/a/b')).toBe('/a');
    expect(parentPath('/a')).toBe('/');
    expect(parentPath('/')).toBe('/');
  });
  it('sorts folders first then alpha', () => {
    const e: FsEntry[] = [
      { name: 'zeta.txt', path: '/zeta.txt', kind: 'file' },
      { name: 'Apps', path: '/Apps', kind: 'dir' },
      { name: 'alpha.txt', path: '/alpha.txt', kind: 'file' },
    ];
    expect(sortEntries(e).map((x) => x.name)).toEqual(['Apps', 'alpha.txt', 'zeta.txt']);
  });
});

describe('MockFS', () => {
  it('lists the seeded root and navigates into a folder', async () => {
    const fs = new MockFS();
    const root = await fs.list('/');
    expect(root.map((e) => e.name)).toContain('Documents');
    const docs = await fs.list('/Documents');
    expect(docs.length).toBeGreaterThan(0);
  });

  it('mkdir then list shows the new folder', async () => {
    const fs = new MockFS();
    await fs.mkdir('/NewFolder');
    const root = await fs.list('/');
    expect(root.find((e) => e.name === 'NewFolder')?.kind).toBe('dir');
  });

  it('round-trips bytes through openWrite/openRead', async () => {
    const fs = new MockFS();
    const w = await fs.openWrite('/hello.bin');
    await w.write(new Uint8Array([1, 2, 3]));
    await w.write(new Uint8Array([4, 5]));
    await w.close();
    const r = await fs.openRead('/hello.bin');
    const buf = new Uint8Array(5);
    const n = await r.read(buf);
    await r.close();
    expect(n).toBe(5);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/fs/MockFS.test.ts`
Expected: FAIL — cannot find module `./MockFS`.

- [ ] **Step 4: Write `src/fs/MockFS.ts`**

```ts
import {
  joinPath,
  parentPath,
  sortEntries,
  type FileSystem,
  type FsEntry,
  type ReadHandle,
  type WriteHandle,
} from './FileSystem';

interface Node {
  entry: FsEntry;
  data?: Uint8Array; // files only
}

/** In-memory filesystem used to exercise the shell before real protocols exist. */
export class MockFS implements FileSystem {
  readonly kind = 'mock' as const;
  private nodes = new Map<string, Node>();

  constructor(readonly label = 'Mock') {
    this.seedDir('/');
    this.seedDir('/Documents');
    this.seedDir('/Documents/Projects');
    this.seedFile('/Documents/notes.txt', 'hello world\n');
    this.seedFile('/Documents/budget.xlsx', 'binary-ish');
    this.seedDir('/Pictures');
    this.seedFile('/Pictures/photo.jpg', 'jpegdata');
    this.seedFile('/readme.md', '# readme\n');
  }

  private seedDir(path: string): void {
    const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    this.nodes.set(path, {
      entry: { name, path, kind: 'dir', mtime: 0 },
    });
  }

  private seedFile(path: string, text: string): void {
    const data = new TextEncoder().encode(text);
    const name = path.slice(path.lastIndexOf('/') + 1);
    this.nodes.set(path, {
      entry: { name, path, kind: 'file', size: data.byteLength, mtime: 0 },
      data,
    });
  }

  async list(path: string): Promise<FsEntry[]> {
    const prefix = path === '/' ? '/' : `${path}/`;
    const out: FsEntry[] = [];
    for (const [p, node] of this.nodes) {
      if (p === path) continue;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue; // direct children only
      out.push(node.entry);
    }
    return sortEntries(out);
  }

  async stat(path: string): Promise<FsEntry> {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`No such path: ${path}`);
    return node.entry;
  }

  async mkdir(path: string): Promise<void> {
    if (this.nodes.has(path)) throw new Error(`Exists: ${path}`);
    const name = path.slice(path.lastIndexOf('/') + 1);
    this.nodes.set(path, { entry: { name, path, kind: 'dir', mtime: Date.now() } });
  }

  async rename(from: string, to: string): Promise<void> {
    const node = this.nodes.get(from);
    if (!node) throw new Error(`No such path: ${from}`);
    this.nodes.delete(from);
    const name = to.slice(to.lastIndexOf('/') + 1);
    node.entry = { ...node.entry, name, path: to };
    this.nodes.set(to, node);
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`No such path: ${path}`);
    if (node.entry.kind === 'dir') {
      const children = await this.list(path);
      if (children.length && !recursive) throw new Error('Directory not empty');
      for (const c of children) await this.remove(c.path, true);
    }
    this.nodes.delete(path);
  }

  async move(from: string, to: string): Promise<void> {
    await this.rename(from, to);
  }

  async openRead(path: string): Promise<ReadHandle> {
    const node = this.nodes.get(path);
    if (!node || node.entry.kind !== 'file' || !node.data) {
      throw new Error(`Not a file: ${path}`);
    }
    const data = node.data;
    let offset = 0;
    return {
      size: data.byteLength,
      async read(into: Uint8Array): Promise<number> {
        if (offset >= data.byteLength) return 0;
        const n = Math.min(into.byteLength, data.byteLength - offset);
        into.set(data.subarray(offset, offset + n));
        offset += n;
        return n;
      },
      async close() {},
    };
  }

  async openWrite(path: string): Promise<WriteHandle> {
    const chunks: Uint8Array[] = [];
    const nodes = this.nodes;
    return {
      async write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
      },
      async close() {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const data = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          data.set(c, o);
          o += c.byteLength;
        }
        const name = path.slice(path.lastIndexOf('/') + 1);
        nodes.set(path, {
          entry: { name, path, kind: 'file', size: total, mtime: Date.now() },
          data,
        });
      },
    };
  }
}

// Re-export helpers consumers expect from here for convenience.
export { joinPath, parentPath };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/fs/MockFS.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/fs/FileSystem.ts src/fs/MockFS.ts src/fs/MockFS.test.ts
git commit -m "feat: FileSystem interface, path helpers, and MockFS"
```

---

## Task 8: Global styles and theme tokens

**Files:**
- Create: `src/index.css`

- [ ] **Step 1: Write `src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg: #f4f5f7;
  --surface: #ffffff;
  --border: #d5d9e0;
  --text: #1b2330;
  --muted: #667085;
  --accent: #2563eb;
  --accent-fg: #ffffff;
}

:root[data-theme='dark'] {
  --bg: #0f172a;
  --surface: #161e2e;
  --border: #2a3346;
  --text: #e6e9ef;
  --muted: #93a0b5;
  --accent: #3b82f6;
  --accent-fg: #ffffff;
}

html, body, #root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}

/* Widget root rule: when embedded as a card, the app IS the card. */
.widget-card {
  border-radius: 24px;
  overflow: hidden;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/index.css
git commit -m "style: tailwind layers and light/dark theme tokens"
```

---

## Task 9: Shell UI primitives

**Files:**
- Create: `src/ui/icons.tsx`
- Create: `src/ui/MenuBar.tsx`
- Create: `src/ui/Toolbar.tsx`
- Create: `src/ui/StatusBar.tsx`
- Create: `src/ui/Splitter.tsx`
- Create: `src/ui/PaneView.tsx`
- Create: `src/ui/TransferQueue.tsx`

- [ ] **Step 1: Write `src/ui/icons.tsx`** (tiny inline SVG set; no external assets)

```tsx
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
```

- [ ] **Step 2: Write `src/ui/MenuBar.tsx`**

```tsx
import { IconMoon, IconSun } from './icons';
import type { ThemeApi } from '../theme/useTheme';

interface Props {
  sessionLabel: string;
  theme: ThemeApi;
  compact?: boolean;
}

export function MenuBar({ sessionLabel, theme, compact }: Props) {
  return (
    <div className="flex items-center gap-3 px-3 h-9 bg-surface border-b border-border select-none">
      <span className="font-semibold">WinSCP Web</span>
      {!compact && <span className="text-muted">Session: {sessionLabel}</span>}
      <button
        className="ml-auto p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text"
        title="Toggle light/dark"
        onClick={theme.toggle}
      >
        {theme.theme === 'dark' ? <IconSun /> : <IconMoon />}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Write `src/ui/Toolbar.tsx`**

```tsx
import { IconRefresh, IconUp, IconDown, IconNewFolder, IconTrash } from './icons';

interface Props {
  onRefresh?: () => void;
  onUpload?: () => void;
  onDownload?: () => void;
  onNewFolder?: () => void;
  onDelete?: () => void;
}

function TBtn({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 h-7 rounded text-text hover:bg-black/5 dark:hover:bg-white/10"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function Toolbar(p: Props) {
  return (
    <div className="flex items-center gap-1 px-2 h-9 bg-surface border-b border-border">
      <TBtn label="Refresh" icon={<IconRefresh />} onClick={p.onRefresh} />
      <TBtn label="Upload" icon={<IconUp />} onClick={p.onUpload} />
      <TBtn label="Download" icon={<IconDown />} onClick={p.onDownload} />
      <TBtn label="New folder" icon={<IconNewFolder />} onClick={p.onNewFolder} />
      <TBtn label="Delete" icon={<IconTrash />} onClick={p.onDelete} />
    </div>
  );
}
```

- [ ] **Step 4: Write `src/ui/StatusBar.tsx`**

```tsx
interface Props {
  left: string;
  right?: string;
}

export function StatusBar({ left, right }: Props) {
  return (
    <div className="flex items-center gap-3 px-3 h-6 bg-surface border-t border-border text-muted text-[11px]">
      <span>{left}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}
```

- [ ] **Step 5: Write `src/ui/Splitter.tsx`** (draggable, fluid — continuous scaling within Commander)

```tsx
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
```

- [ ] **Step 6: Write `src/ui/PaneView.tsx`** (dense sortable file list — thick-app feel)

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { FileSystem, FsEntry } from '../fs/FileSystem';
import { parentPath } from '../fs/FileSystem';
import { IconFolder, IconFile } from './icons';

type SortKey = 'name' | 'size' | 'mtime';

interface Props {
  fs: FileSystem;
  header: string;
}

function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(ms?: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function PaneView({ fs, header }: Props) {
  const [cwd, setCwd] = useState('/');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    fs.list(cwd)
      .then((e) => alive && setEntries(e))
      .catch((err) => alive && setError(String(err?.message ?? err)));
    return () => {
      alive = false;
    };
  }, [fs, cwd]);

  const rows = useMemo(() => {
    const sorted = [...entries];
    if (sortKey === 'size') sorted.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    else if (sortKey === 'mtime') sorted.sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0));
    return sorted;
  }, [entries, sortKey]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      <div className="px-2 py-1 border-b border-border font-semibold flex items-center gap-2">
        <span className="truncate">{header}</span>
        <span className="text-muted font-normal truncate">· {cwd}</span>
      </div>
      <div className="grid grid-cols-[1fr_80px_130px] px-2 py-1 text-[11px] text-muted border-b border-border">
        <button className="text-left" onClick={() => setSortKey('name')}>Name</button>
        <button className="text-right" onClick={() => setSortKey('size')}>Size</button>
        <button className="text-right" onClick={() => setSortKey('mtime')}>Modified</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto font-mono text-[12px]">
        {cwd !== '/' && (
          <button
            className="w-full text-left px-2 py-0.5 hover:bg-accent/10"
            onDoubleClick={() => setCwd(parentPath(cwd))}
            onClick={() => setCwd(parentPath(cwd))}
          >
            📁 ..
          </button>
        )}
        {error && <div className="px-2 py-2 text-red-500">{error}</div>}
        {rows.map((e) => (
          <div
            key={e.path}
            className={`grid grid-cols-[1fr_80px_130px] px-2 py-0.5 cursor-default ${
              selected.has(e.path) ? 'bg-accent/20' : 'hover:bg-accent/10'
            }`}
            onClick={() => setSelected(new Set([e.path]))}
            onDoubleClick={() => e.kind === 'dir' && setCwd(e.path)}
          >
            <span className="flex items-center gap-1 truncate">
              {e.kind === 'dir' ? <IconFolder /> : <IconFile />}
              {e.name}
            </span>
            <span className="text-right text-muted">{e.kind === 'dir' ? '' : fmtSize(e.size)}</span>
            <span className="text-right text-muted">{fmtDate(e.mtime)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Write `src/ui/TransferQueue.tsx`** (placeholder queue surface)

```tsx
export interface QueueItem {
  id: string;
  label: string;
  direction: 'up' | 'down';
  progress: number; // 0..1
  done: boolean;
}

export function TransferQueue({ items }: { items: QueueItem[] }) {
  return (
    <div className="border-t border-border bg-surface px-3 py-1 text-[11px]">
      <div className="text-muted uppercase tracking-wide mb-0.5">Transfer queue</div>
      {items.length === 0 && <div className="text-muted">No transfers.</div>}
      {items.map((it) => (
        <div key={it.id} className="flex items-center gap-2">
          <span>{it.direction === 'up' ? '⬆' : '⬇'}</span>
          <span className="truncate flex-1">{it.label}</span>
          <span className="text-muted">{it.done ? '✓' : `${Math.round(it.progress * 100)}%`}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Typecheck (deferred if entry missing)**

Run: `npx tsc -b`
Expected: no errors once Task 11 adds the entry; type-only errors about unused files are acceptable
until then.

- [ ] **Step 9: Commit**

```bash
git add src/ui
git commit -m "feat: thick-app shell primitives (menu, toolbar, panes, splitter, queue)"
```

---

## Task 10: App context provider

**Files:**
- Create: `src/state/AppProvider.tsx`

- [ ] **Step 1: Write `src/state/AppProvider.tsx`**

```tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useTheme, type ThemeApi } from '../theme/useTheme';
import { MockFS } from '../fs/MockFS';
import type { FileSystem } from '../fs/FileSystem';

interface AppState {
  theme: ThemeApi;
  local: FileSystem;
  remote: FileSystem | null;
  splitRatio: number;
  setSplitRatio: (r: number) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [splitRatio, setSplitRatio] = useState(0.5);
  // Phase 1 shell: both sides are mock filesystems. Real OneDrive/SFTP arrive in
  // later plans; the UI already renders from the FileSystem interface.
  const local = useMemo(() => new MockFS('OneDrive'), []);
  const remote = useMemo(() => new MockFS('deploy@host'), []);

  const value: AppState = { theme, local, remote, splitRatio, setSplitRatio };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/state/AppProvider.tsx
git commit -m "feat: app context provider with mock local/remote filesystems"
```

---

## Task 11: Layouts + App switch + bootstrap

**Files:**
- Create: `src/layouts/Commander.tsx`, `src/layouts/TabbedSingle.tsx`, `src/layouts/StatusTile.tsx`
- Create: `src/App.tsx`
- Create: `src/main.tsx`

- [ ] **Step 1: Write `src/layouts/Commander.tsx`**

```tsx
import { useApp } from '../state/AppProvider';
import { MenuBar } from '../ui/MenuBar';
import { Toolbar } from '../ui/Toolbar';
import { StatusBar } from '../ui/StatusBar';
import { Splitter } from '../ui/Splitter';
import { PaneView } from '../ui/PaneView';
import { TransferQueue } from '../ui/TransferQueue';

export function Commander() {
  const { theme, local, remote, splitRatio, setSplitRatio } = useApp();
  return (
    <div className="flex flex-col h-full">
      <MenuBar sessionLabel={remote?.label ?? 'not connected'} theme={theme} />
      <Toolbar />
      <div className="flex flex-1 min-h-0">
        <div style={{ width: `${splitRatio * 100}%` }} className="min-w-0 border-r border-border">
          <PaneView fs={local} header={local.label} />
        </div>
        <Splitter ratio={splitRatio} onRatio={setSplitRatio} />
        <div className="flex-1 min-w-0">
          {remote ? (
            <PaneView fs={remote} header={remote.label} />
          ) : (
            <div className="p-4 text-muted">Not connected.</div>
          )}
        </div>
      </div>
      <TransferQueue items={[]} />
      <StatusBar left={`Local: ${local.label}`} right={remote ? `Remote: ${remote.label}` : 'No session'} />
    </div>
  );
}
```

- [ ] **Step 2: Write `src/layouts/TabbedSingle.tsx`**

```tsx
import { useState } from 'react';
import { useApp } from '../state/AppProvider';
import { MenuBar } from '../ui/MenuBar';
import { Toolbar } from '../ui/Toolbar';
import { StatusBar } from '../ui/StatusBar';
import { PaneView } from '../ui/PaneView';
import { TransferQueue } from '../ui/TransferQueue';

export function TabbedSingle() {
  const { theme, local, remote } = useApp();
  const [side, setSide] = useState<'local' | 'remote'>('local');
  const fs = side === 'local' ? local : remote;

  return (
    <div className="flex flex-col h-full">
      <MenuBar sessionLabel={remote?.label ?? 'not connected'} theme={theme} compact />
      <div className="flex gap-1 p-1 bg-surface border-b border-border">
        <button
          className={`flex-1 h-7 rounded ${side === 'local' ? 'bg-accent text-accent-fg' : 'text-text'}`}
          onClick={() => setSide('local')}
        >
          ☁ {local.label}
        </button>
        <button
          className={`flex-1 h-7 rounded ${side === 'remote' ? 'bg-accent text-accent-fg' : 'text-text'}`}
          onClick={() => setSide('remote')}
        >
          🖥 {remote?.label ?? 'remote'}
        </button>
      </div>
      <Toolbar />
      <div className="flex-1 min-h-0">
        {fs ? <PaneView fs={fs} header={fs.label} /> : <div className="p-4 text-muted">Not connected.</div>}
      </div>
      <TransferQueue items={[]} />
      <StatusBar left={side === 'local' ? local.label : (remote?.label ?? 'remote')} />
    </div>
  );
}
```

- [ ] **Step 3: Write `src/layouts/StatusTile.tsx`**

```tsx
import { useApp } from '../state/AppProvider';

export function StatusTile() {
  const { remote } = useApp();
  return (
    <div className="widget-card flex flex-col h-full bg-surface p-2 text-[11px]">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-semibold">WinSCP Web</span>
        <span className="ml-auto text-muted">{remote?.label ?? 'no session'} ●</span>
      </div>
      <div className="text-muted">No active transfers.</div>
      <button className="mt-auto h-7 rounded bg-accent text-accent-fg">↗ Open full app</button>
    </div>
  );
}
```

- [ ] **Step 4: Write `src/App.tsx`**

```tsx
import { AppProvider } from './state/AppProvider';
import { usePlatform } from './platform/usePlatform';
import { Commander } from './layouts/Commander';
import { TabbedSingle } from './layouts/TabbedSingle';
import { StatusTile } from './layouts/StatusTile';

function Root() {
  const layout = usePlatform();
  if (layout.mode === 'commander') return <Commander />;
  if (layout.mode === 'tile') return <StatusTile />;
  return <TabbedSingle />;
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
```

- [ ] **Step 5: Write `src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Typecheck the whole tree**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/layouts src/App.tsx src/main.tsx
git commit -m "feat: layout-mode switch and app bootstrap"
```

---

## Task 12: PWA icons + full build + test verification

**Files:**
- Create: `public/favicon.svg`, `public/pwa-192.png`, `public/pwa-512.png`

- [ ] **Step 1: Create `public/favicon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#2563eb"/>
  <path d="M8 11h16M8 16h16M8 21h10" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
</svg>
```

- [ ] **Step 2: Generate the two PNG icons from the SVG**

Run (uses the sharp-free approach via ImageMagick if present; otherwise use the Node fallback below):
```bash
node -e "const fs=require('fs'); const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64'); fs.writeFileSync('public/pwa-192.png',png); fs.writeFileSync('public/pwa-512.png',png);"
```
Expected: two placeholder PNG files exist. (These are valid 1×1 PNGs that satisfy the manifest and
build; replace with real 192/512 icons before shipping. The build does not validate icon dimensions.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites (profiles, theme, MockFS) green.

- [ ] **Step 4: Run the production build**

Run: `npm run build`
Expected: exit 0; `dist/` contains `index.html`, hashed JS/CSS, `manifest.webmanifest`, `sw.js`,
and the icons. No server output.

- [ ] **Step 5: Verify the build is static-only**

Run: `ls dist`
Expected: only static assets (html/js/css/svg/png/webmanifest/sw). Confirm there is no node/server
entrypoint.

- [ ] **Step 6: Commit**

```bash
git add public
git commit -m "chore: pwa icons; verified static build and tests"
```

---

## Self-Review

**Spec coverage (Plan 1's slice of the Phase 1 spec):**
- §2.1 static SPA — Task 2 (no SSR/edge), Task 12 (verified static `dist/`). ✓
- §2.4 multi-context rendering — Tasks 3–4 (classifier + hook), Task 11 (three layouts). ✓
- §2.5 PWA/full-screen — Task 2 (vite-plugin-pwa), Task 12 (build emits manifest + sw). ✓
- §2.6 light/dark — Tasks 5–6, Task 8 (tokens), MenuBar toggle. ✓
- §2.7 lockfile — Task 1 Step 2. ✓
- §3.2 FileSystem seam — Task 7 (interface + MockFS). ✓
- §4.1 fluid modes — Task 3 thresholds match the four mandated sizes + side panel. ✓
- §4.2 thick-app feel (partial: columns/sort/select; full context-menus, DnD, keymap land in Plan 6). ✓ for this slice.
- OneDrive, SSH, SFTP, vault, transfer engine — intentionally deferred to Plans 2–6.

**Placeholder scan:** MockFS and placeholder PNGs are deliberate stand-ins for this plan's scope,
each labeled; no "TBD"/"add error handling"-style gaps in steps. ✓

**Type consistency:** `FileSystem`/`FsEntry`/`ReadHandle`/`WriteHandle` used identically across
`FileSystem.ts`, `MockFS.ts`, `PaneView.tsx`, `AppProvider.tsx`; `ThemeApi` from `useTheme` matches
`MenuBar` prop; `Layout.mode` values (`commander`/`tabbed`/`tile`) match `App.tsx` switch. ✓
