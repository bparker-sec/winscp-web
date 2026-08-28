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
import { Vault, type VaultState } from '../connections/vault';
import { ConnectionStore, type SavedConnection } from '../connections/store';
import { parseOpenSshPrivateKey } from '../ssh/privatekey';

export type ConnectDialogPrefill = Partial<
  Pick<SavedConnection, 'name' | 'host' | 'port' | 'username' | 'authMethod' | 'alwaysPrompt'>
>;

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
  connectDialogPrefill: ConnectDialogPrefill | null;
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
  // Connection manager / vault
  connections: SavedConnection[];
  connectionManagerOpen: boolean;
  passphraseDialog: { mode: 'set' | 'unlock' } | null;
  vaultState: VaultState;
  openConnectionManager: () => void;
  closeConnectionManager: () => void;
  saveConnection: (conn: SavedConnection, secret?: string) => Promise<void>;
  deleteConnection: (id: string) => void;
  duplicateConnection: (id: string) => void;
  setMasterPassphrase: (pass: string) => Promise<void>;
  unlockVault: (pass: string) => Promise<boolean>;
  closePassphraseDialog: () => void;
  connectSaved: (id: string) => Promise<void>;
  openConnectDialogPrefilled: (prefill: ConnectDialogPrefill) => void;
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
  const [connectDialogPrefill, setConnectDialogPrefill] = useState<ConnectDialogPrefill | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPromptState | null>(null);
  const remoteConnRef = useRef<SftpConnection | null>(null);
  const hostKeyResolverRef = useRef<((accept: boolean) => void) | null>(null);
  const pendingHostRef = useRef<{ host: string; port: number } | null>(null);

  // Vault + connection store
  const vault = useMemo(() => new Vault(), []);
  const store = useMemo(() => new ConnectionStore(vault), [vault]);
  const [connections, setConnections] = useState<SavedConnection[]>(() => store.list());
  const [connectionManagerOpen, setConnectionManagerOpen] = useState(false);
  const [passphraseDialog, setPassphraseDialog] = useState<{ mode: 'set' | 'unlock' } | null>(null);
  const [vaultState, setVaultState] = useState<VaultState>(vault.state);
  const pendingSaveRef = useRef<{ conn: SavedConnection; secret?: string } | null>(null);
  const pendingConnectIdRef = useRef<string | null>(null);
  const connectSavedRef = useRef<((id: string) => Promise<void>) | null>(null);

  const refreshConnections = useCallback(() => {
    setConnections(store.list());
  }, [store]);

  const openConnectDialog = useCallback(() => {
    setRemoteError(null);
    setConnectDialogPrefill(null);
    setConnectDialogOpen(true);
  }, []);

  const openConnectDialogPrefilled = useCallback((prefill: ConnectDialogPrefill) => {
    setRemoteError(null);
    setConnectDialogPrefill(prefill);
    setConnectDialogOpen(true);
  }, []);

  const closeConnectDialog = useCallback(() => {
    setConnectDialogOpen(false);
    setConnectDialogPrefill(null);
  }, []);

  const openConnectionManager = useCallback(() => {
    refreshConnections();
    setConnectionManagerOpen(true);
  }, [refreshConnections]);

  const closeConnectionManager = useCallback(() => {
    setConnectionManagerOpen(false);
  }, []);

  const closePassphraseDialog = useCallback(() => {
    setPassphraseDialog(null);
    pendingSaveRef.current = null;
    pendingConnectIdRef.current = null;
  }, []);

  const saveConnection = useCallback(
    async (conn: SavedConnection, secret?: string) => {
      const wantsSecret = secret !== undefined && !conn.alwaysPrompt;
      if (wantsSecret && vault.state === 'uninitialized') {
        pendingSaveRef.current = { conn, secret };
        setPassphraseDialog({ mode: 'set' });
        return;
      }
      if (wantsSecret && vault.state === 'locked') {
        pendingSaveRef.current = { conn, secret };
        setPassphraseDialog({ mode: 'unlock' });
        return;
      }
      await store.save(conn, secret);
      refreshConnections();
    },
    [store, vault, refreshConnections],
  );

  const deleteConnection = useCallback(
    (id: string) => {
      store.remove(id);
      refreshConnections();
    },
    [store, refreshConnections],
  );

  const duplicateConnection = useCallback(
    (id: string) => {
      store.duplicate(id);
      refreshConnections();
    },
    [store, refreshConnections],
  );

  const runPendingSave = useCallback(async () => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;
    await store.save(pending.conn, pending.secret);
    refreshConnections();
  }, [store, refreshConnections]);

  const setMasterPassphrase = useCallback(
    async (pass: string) => {
      await vault.initialize(pass);
      setVaultState(vault.state);
      setPassphraseDialog(null);
      await runPendingSave();
      const pendingConnectId = pendingConnectIdRef.current;
      pendingConnectIdRef.current = null;
      if (pendingConnectId) {
        await connectSavedRef.current?.(pendingConnectId);
      }
    },
    [vault, runPendingSave],
  );

  const unlockVault = useCallback(
    async (pass: string): Promise<boolean> => {
      const ok = await vault.unlock(pass);
      setVaultState(vault.state);
      if (ok) {
        setPassphraseDialog(null);
        await runPendingSave();
        const pendingConnectId = pendingConnectIdRef.current;
        pendingConnectIdRef.current = null;
        if (pendingConnectId) {
          await connectSavedRef.current?.(pendingConnectId);
        }
      }
      return ok;
    },
    [vault, runPendingSave],
  );

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

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      setRemoteConnecting(false);
      setRemoteError('Connection timed out after 30s.');
      setHostKeyPrompt(null);
      hostKeyResolverRef.current = null;
    }, 30000);

    connectSftp(creds, trust, `${creds.username}@${creds.host}`).then(
      (conn) => {
        window.clearTimeout(timer);
        if (settled) {
          // We already timed out/failed — don't leak this late-arriving session.
          void conn.close().catch(() => {});
          return;
        }
        settled = true;
        remoteConnRef.current = conn;
        setRemote(conn.fs);
        setRemoteHome(conn.home);
        setRemoteConnecting(false);
        setConnectDialogOpen(false);
      },
      (e) => {
        window.clearTimeout(timer);
        if (settled) return;
        settled = true;
        setRemoteConnecting(false);
        setRemoteError(e instanceof Error ? e.message : String(e));
        setHostKeyPrompt(null);
        hostKeyResolverRef.current = null;
      },
    );
  }, []);

  const connectSaved = useCallback(
    async (id: string) => {
      const conn = store.get(id);
      if (!conn) return;

      if (!conn.alwaysPrompt && store.hasSecret(id)) {
        if (vault.state !== 'unlocked') {
          pendingConnectIdRef.current = id;
          setPassphraseDialog({ mode: vault.state === 'uninitialized' ? 'set' : 'unlock' });
          return;
        }
        const secret = await store.getSecret(id);
        const creds: SftpCredentials = { host: conn.host, port: conn.port, username: conn.username };
        if (conn.authMethod === 'key' && secret) {
          try {
            const k = parseOpenSshPrivateKey(secret);
            creds.privateKey = { seed: k.seed, publicKey: k.publicKey };
          } catch {
            setRemoteError('Unsupported or invalid private key (encrypted keys are not yet supported).');
            return;
          }
        } else if (secret) {
          creds.password = secret;
        }
        remoteConnect(creds);
        return;
      }

      // No stored secret, or the connection is marked "always prompt": open
      // the Connect dialog prefilled with the saved metadata so the user can
      // supply the secret by hand.
      openConnectDialogPrefilled({
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        authMethod: conn.authMethod,
        alwaysPrompt: conn.alwaysPrompt,
      });
    },
    [store, vault, remoteConnect, openConnectDialogPrefilled],
  );
  connectSavedRef.current = connectSaved;

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
    connectDialogPrefill,
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
    connections,
    connectionManagerOpen,
    passphraseDialog,
    vaultState,
    openConnectionManager,
    closeConnectionManager,
    saveConnection,
    deleteConnection,
    duplicateConnection,
    setMasterPassphrase,
    unlockVault,
    closePassphraseDialog,
    connectSaved,
    openConnectDialogPrefilled,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}
