import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTheme, type ThemeApi } from '../theme/useTheme';
import type { FileSystem } from '../fs/FileSystem';
import { OneDriveFS } from '../onedrive/OneDriveFS';
import {
  oneDriveAuth,
  connectOneDrive,
  clearOneDriveSession,
  trySilentOneDrive,
} from '../onedrive/auth';
import { sdkGetUser } from '../sdk/client';
import { connectSftp, type SftpConnection, type SftpCredentials } from '../sftp/SftpConnection';
import { rememberHost } from '../ssh/knownhosts';

interface HostKeyPromptState {
  host: string;
  fingerprint: string;
  status: 'new' | 'match' | 'mismatch';
}

interface AppState {
  theme: ThemeApi;
  local: FileSystem | null; // null until OneDrive is connected
  remote: FileSystem | null; // null until an SFTP connection is established
  remoteHome: string;
  remoteConnecting: boolean;
  remoteError: string | null;
  connectDialogOpen: boolean;
  hostKeyPrompt: HostKeyPromptState | null;
  openConnectDialog: () => void;
  closeConnectDialog: () => void;
  remoteConnect: (creds: SftpCredentials) => void;
  remoteDisconnect: () => void;
  resolveHostKey: (accept: boolean) => void;
  connecting: boolean;
  connectError: string | null;
  userName?: string;
  connect: () => void;
  disconnect: () => void;
  splitRatio: number;
  setSplitRatio: (r: number) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [signedIn, setSignedIn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | undefined>(undefined);

  const local = useMemo<FileSystem | null>(
    () => (signedIn ? new OneDriveFS(oneDriveAuth, userName ? `OneDrive · ${userName}` : 'OneDrive') : null),
    [signedIn, userName],
  );

  const [remote, setRemote] = useState<FileSystem | null>(null);
  const [remoteHome, setRemoteHome] = useState('/');
  const [remoteConnecting, setRemoteConnecting] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptState | null>(null);
  const remoteConnRef = useRef<SftpConnection | null>(null);
  const hostKeyResolverRef = useRef<((accept: boolean) => void) | null>(null);
  const pendingHostRef = useRef<{ host: string; port: number } | null>(null);

  const openConnectDialog = useCallback(() => {
    setRemoteError(null);
    setConnectDialogOpen(true);
  }, []);

  const closeConnectDialog = useCallback(() => {
    setConnectDialogOpen(false);
  }, []);

  const refreshUser = useCallback(async () => {
    const u = await sdkGetUser();
    setUserName(u?.displayName ?? u?.name ?? u?.email ?? undefined);
  }, []);

  // Attempt a silent reconnect on mount (no OAuth popup). Fetch the user BEFORE
  // flipping signedIn so `local` (OneDriveFS) is constructed once, not twice.
  useEffect(() => {
    let alive = true;
    trySilentOneDrive().then(async (ok) => {
      if (!alive || !ok) return;
      await refreshUser();
      if (!alive) return;
      setSignedIn(true);
    });
    return () => {
      alive = false;
    };
  }, [refreshUser]);

  const connect = useCallback(() => {
    setConnecting(true);
    setConnectError(null);
    connectOneDrive().then(async (res) => {
      if (res.ok) {
        await refreshUser();
        setSignedIn(true);
        setConnecting(false);
      } else {
        setConnecting(false);
        // 'superseded'/'blocked' are internal coordinator states (e.g. a sign-out
        // raced this connect), not user-facing failures.
        if (res.reason !== 'superseded' && res.reason !== 'blocked') {
          setConnectError(res.detail ?? 'Could not connect to OneDrive.');
        }
      }
    });
  }, [refreshUser]);

  const disconnect = useCallback(() => {
    setConnectError(null);
    clearOneDriveSession().then(() => {
      setSignedIn(false);
      setUserName(undefined);
    });
  }, []);

  const resolveHostKey = useCallback((accept: boolean) => {
    const resolver = hostKeyResolverRef.current;
    const prompt = hostKeyPrompt;
    if (accept && prompt && pendingHostRef.current) {
      rememberHost(pendingHostRef.current.host, pendingHostRef.current.port, prompt.fingerprint);
    }
    setHostKeyPrompt(null);
    hostKeyResolverRef.current = null;
    resolver?.(accept);
  }, [hostKeyPrompt]);

  const remoteConnect = useCallback((creds: SftpCredentials) => {
    setRemoteConnecting(true);
    setRemoteError(null);

    const trust = (info: { host: string; port: number; fingerprint: string; status: 'new' | 'match' | 'mismatch' }) => {
      if (info.status === 'match') return true;
      return new Promise<boolean>((resolve) => {
        pendingHostRef.current = { host: info.host, port: info.port };
        hostKeyResolverRef.current = resolve;
        setHostKeyPrompt({ host: `${info.host}:${info.port}`, fingerprint: info.fingerprint, status: info.status });
      });
    };

    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('Connection timed out after 30s.')), 30000);
    });

    Promise.race([connectSftp(creds, trust, `${creds.username}@${creds.host}`), timeout])
      .then((conn) => {
        remoteConnRef.current = conn;
        setRemote(conn.fs);
        setRemoteHome(conn.home);
        setRemoteConnecting(false);
        setConnectDialogOpen(false);
      })
      .catch((e) => {
        setRemoteConnecting(false);
        setRemoteError(e instanceof Error ? e.message : String(e));
        setHostKeyPrompt(null);
        hostKeyResolverRef.current = null;
      });
  }, []);

  const remoteDisconnect = useCallback(() => {
    remoteConnRef.current?.close().catch(() => {});
    remoteConnRef.current = null;
    setRemote(null);
    setRemoteHome('/');
    setRemoteError(null);
  }, []);

  const value: AppState = {
    theme,
    local,
    remote,
    remoteHome,
    remoteConnecting,
    remoteError,
    connectDialogOpen,
    hostKeyPrompt,
    openConnectDialog,
    closeConnectDialog,
    remoteConnect,
    remoteDisconnect,
    resolveHostKey,
    connecting,
    connectError,
    userName,
    connect,
    disconnect,
    splitRatio,
    setSplitRatio,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}
