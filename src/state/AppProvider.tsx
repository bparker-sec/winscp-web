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
