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
import { FsError, joinPath, type FileSystem, type FsEntry } from '../fs/FileSystem';
import {
  computeSyncPlan,
  planTotalBytes,
  type SyncAction,
  type SyncMode,
  type CompareBy,
} from '../transfer/sync';
import { OneDriveFS } from '../onedrive/OneDriveFS';
import {
  oneDriveAuth,
  connectOneDrive,
  clearOneDriveSession,
  trySilentOneDrive,
} from '../onedrive/auth';
import { sdkGetUser } from '../sdk/client';
import type { SftpCredentials } from '../sftp/SftpConnection';
import {
  connectRemote,
  remoteTarget,
  isSshProtocol,
  type RemoteConnection,
  type RemoteCredentials,
} from '../remote/connect';
import { rememberHost } from '../ssh/knownhosts';
import { Vault, type VaultState } from '../connections/vault';
import { ConnectionStore, type SavedConnection } from '../connections/store';
import { parseOpenSshPrivateKey } from '../ssh/privatekey';
import { TransferQueue, type TransferJob, type ConflictChoice } from '../transfer/queue';
import { diag } from '../diagnostics/log';
import { getSettings, setSettings } from '../settings/appSettings';
import { describeError } from '../fs/describeError';

/** A connection is auto-retried at most once after an unexpected close before
 * falling back to the manual connections view -- this bounds any possible
 * reconnect loop to a single extra attempt. */
const MAX_AUTO_RECONNECT_ATTEMPTS = 1;

/** A connection that stayed up at least this long before dropping is treated as
 * a genuine long-lived session, so its loss earns a fresh auto-reconnect budget.
 * A connection that drops sooner is a flap: it keeps the (already-incremented)
 * budget, so repeated fast drops fall back to the manual connections view after
 * one auto-retry instead of looping forever. */
const STABLE_CONNECTION_MS = 30_000;

function errorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === 'string' || typeof c === 'number') return String(c);
  }
  return undefined;
}

export type ConnectDialogPrefill = Partial<
  Pick<SavedConnection, 'id' | 'name' | 'host' | 'port' | 'username' | 'authMethod' | 'alwaysPrompt'>
>;

interface HostKeyPromptState {
  host: string;
  fingerprint: string;
  status: 'new' | 'match' | 'mismatch';
}

interface ConflictPromptState {
  name: string;
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
  remoteConnect: (creds: RemoteCredentials) => void;
  remoteDisconnect: () => void;
  // Multi-session tabs
  remoteSessions: RemoteSessionInfo[];
  activeSessionId: string | null;
  switchSession: (id: string) => void;
  closeSession: (id: string) => void;
  openNewSession: () => void;
  /** Reconnect using the last successfully-connected credentials (session-only). */
  reconnectLast: () => void;
  /** True when there are retained credentials `reconnectLast` can use. */
  canReconnect: boolean;
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
  // Transfers
  jobs: TransferJob[];
  conflictPrompt: ConflictPromptState | null;
  resolveConflict: (choice: ConflictChoice, applyToAll: boolean) => void;
  enqueueTransfer: (opts: { from: 'local' | 'remote'; entries: FsEntry[]; toDir: string }) => void;
  // Synchronize (directory sync/mirror between the two panes' current folders)
  canSync: boolean;
  syncOpen: boolean;
  openSync: () => void;
  closeSync: () => void;
  previewSync: (req: SyncRequest) => Promise<SyncSummary>;
  applySync: (req: SyncRequest) => Promise<void>;
  cancelJob: (id: string) => void;
  cancelAllJobs: () => void;
  retryJob: (id: string) => void;
  clearFinished: () => void;
  localCwd: string;
  setLocalCwd: (path: string) => void;
  remoteCwd: string;
  setRemoteCwd: (path: string) => void;
  localSelection: FsEntry[];
  setLocalSelection: (entries: FsEntry[]) => void;
  remoteSelection: FsEntry[];
  setRemoteSelection: (entries: FsEntry[]) => void;
  /** Bumped once per completed transfer whose destination is the local pane, so
   * the local PaneView re-lists its current directory. */
  localRefreshNonce: number;
  /** Bumped once per completed transfer whose destination is the remote pane. */
  remoteRefreshNonce: number;
  // Settings / diagnostics
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  vaultLockMinutes: number;
  setVaultLockMinutes: (minutes: number) => void;
  // Transfer performance
  pipelineDepth: number;
  setPipelineDepth: (depth: number) => void;
  transferWindowMB: number;
  setTransferWindowMB: (mb: number) => void;
}

/** A synchronize request: which pane is the source of truth, and the compare rules. */
export interface SyncRequest {
  from: 'local' | 'remote';
  mode: SyncMode;
  compareBy: CompareBy;
}
export interface SyncSummary {
  copy: number;
  mkdir: number;
  del: number;
  bytes: number;
  actions: SyncAction[];
}

/** A remote session tab as surfaced to the UI. */
export interface RemoteSessionInfo {
  id: string;
  label: string;
  active: boolean;
  /** True if this parked session's connection dropped while in the background. */
  dropped: boolean;
}

/** Internal snapshot of a parked (non-active) remote session's live state. */
interface ParkedSession {
  id: string;
  label: string;
  fs: FileSystem;
  home: string;
  cwd: string;
  selection: FsEntry[];
  conn: RemoteConnection;
  creds: RemoteCredentials | null;
  dropped: boolean;
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
  const remoteConnRef = useRef<RemoteConnection | null>(null);
  const hostKeyResolverRef = useRef<((accept: boolean) => void) | null>(null);

  // --- Multi-session tabs ---
  // The single-remote state above IS the active session. Non-active sessions are
  // "parked": their full live state is snapshotted here and swapped back into the
  // active slots when the user switches tabs. The active-session connect/
  // reconnect/disconnect code paths are otherwise unchanged.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const [parkedSessions, setParkedSessions] = useState<ParkedSession[]>([]);
  const parkedSessionsRef = useRef<ParkedSession[]>([]);
  // Kept in sync so callbacks (onClosed) read current values without stale closures.
  parkedSessionsRef.current = parkedSessions;
  // Stable left-to-right tab order (session ids); active + parked both live here.
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const remoteCwdRef = useRef('/');
  const remoteSelectionRef = useRef<FsEntry[]>([]);
  const remoteLabelRef = useRef<string>('');
  const remoteFsRef = useRef<FileSystem | null>(null);
  const remoteHomeRef = useRef('/');
  const pendingHostRef = useRef<{ host: string; port: number } | null>(null);
  // The last credentials that produced a SUCCESSFUL connect, kept only for the
  // lifetime of this session/unlocked-vault (never persisted). Used to drive
  // auto-reconnect after an unexpected connection loss, and the manual
  // "Reconnect" affordance. Cleared on an intentional disconnect.
  const lastRemoteCredsRef = useRef<RemoteCredentials | null>(null);
  const [canReconnect, setCanReconnect] = useState(false);
  // Counts automatic (non-user-initiated) reconnect attempts since the last
  // fully successful connect. Bounded by MAX_AUTO_RECONNECT_ATTEMPTS so a
  // server that keeps dropping the connection can't trigger an infinite loop
  // -- a failed auto-reconnect leaves this at its cap and falls back to the
  // manual connections view instead of retrying again.
  const reconnectAttemptsRef = useRef(0);
  // Wall-clock time of the last successful connect, used to distinguish a
  // genuine long-lived session that dropped (fresh reconnect budget) from a
  // rapid flap (keep the budget so it falls back to manual after one retry).
  const connectedAtRef = useRef(0);
  // Always-current handler for SftpConnection's onClosed callback. Declared as
  // a ref (rather than passed directly) because the connect call that installs
  // the callback happens inside performConnect, which is defined before
  // handleConnectionLost (which itself calls back into performConnect).
  const handleSessionClosedRef = useRef<(sessionId: string, reason: string) => void>(() => {});

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
  const vaultLockTimerRef = useRef<number | null>(null);
  const [vaultLockMinutes, setVaultLockMinutesState] = useState<number>(
    () => getSettings().vaultLockMinutes,
  );
  const [pipelineDepth, setPipelineDepthState] = useState<number>(() => getSettings().pipelineDepth);
  const [transferWindowMB, setTransferWindowMBState] = useState<number>(
    () => getSettings().transferWindowMB,
  );

  const setPipelineDepth = useCallback((depth: number) => {
    setSettings({ pipelineDepth: depth });
    // Read back the sanitized/clamped value so state matches what's persisted.
    setPipelineDepthState(getSettings().pipelineDepth);
  }, []);
  const setTransferWindowMB = useCallback((mb: number) => {
    setSettings({ transferWindowMB: mb });
    setTransferWindowMBState(getSettings().transferWindowMB);
  }, []);

  // Sliding auto-lock: any successful unlock or vault use restarts this timer.
  // If nothing touches the vault for `vaultLockMinutes` of inactivity, it locks
  // itself. A setting of 0 means "never auto-lock" -- stay unlocked for the
  // session (no timer is armed).
  const clearVaultLockTimer = useCallback(() => {
    if (vaultLockTimerRef.current !== null) {
      window.clearTimeout(vaultLockTimerRef.current);
      vaultLockTimerRef.current = null;
    }
  }, []);

  const touchVault = useCallback(() => {
    clearVaultLockTimer();
    const minutes = getSettings().vaultLockMinutes;
    if (minutes <= 0) return;
    vaultLockTimerRef.current = window.setTimeout(() => {
      vaultLockTimerRef.current = null;
      vault.lock();
      setVaultState(vault.state);
      diag.info('Vault auto-locked after inactivity');
    }, minutes * 60_000);
  }, [clearVaultLockTimer, vault]);

  const setVaultLockMinutes = useCallback(
    (minutes: number) => {
      setSettings({ vaultLockMinutes: minutes });
      setVaultLockMinutesState(minutes);
      // Re-arm immediately so the new duration takes effect while unlocked
      // (or clears the timer entirely if the vault is locked/uninitialized).
      if (vault.state === 'unlocked') {
        touchVault();
      } else {
        clearVaultLockTimer();
      }
    },
    [vault, touchVault, clearVaultLockTimer],
  );

  useEffect(() => clearVaultLockTimer, [clearVaultLockTimer]);

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
      touchVault();
      setPassphraseDialog(null);
      await runPendingSave();
      const pendingConnectId = pendingConnectIdRef.current;
      pendingConnectIdRef.current = null;
      if (pendingConnectId) {
        await connectSavedRef.current?.(pendingConnectId);
      }
    },
    [vault, runPendingSave, touchVault],
  );

  const unlockVault = useCallback(
    async (pass: string): Promise<boolean> => {
      const ok = await vault.unlock(pass);
      setVaultState(vault.state);
      if (ok) {
        touchVault();
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
    [vault, runPendingSave, touchVault],
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
    diag.info('Connecting to OneDrive');
    connectOneDrive().then(async (res) => {
      if (res.ok) {
        await refreshUser();
        setSignedIn(true);
        setConnecting(false);
        diag.info('Connected to OneDrive');
      } else {
        setConnecting(false);
        // 'superseded'/'blocked' are internal coordinator states (e.g. a sign-out
        // raced this connect), not user-facing failures.
        if (res.reason !== 'superseded' && res.reason !== 'blocked') {
          setConnectError(res.detail ?? 'Could not connect to OneDrive.');
          diag.error('OneDrive connect failed', { code: res.reason, detail: res.detail });
        }
      }
    });
  }, [refreshUser]);

  const disconnect = useCallback(() => {
    setConnectError(null);
    clearOneDriveSession().then(() => {
      setSignedIn(false);
      setUserName(undefined);
      diag.info('Disconnected from OneDrive');
    });
  }, []);

  const resolveHostKey = useCallback((accept: boolean) => {
    const resolver = hostKeyResolverRef.current;
    const prompt = hostKeyPrompt;
    if (accept && prompt && pendingHostRef.current) {
      rememberHost(pendingHostRef.current.host, pendingHostRef.current.port, prompt.fingerprint);
    }
    if (prompt) {
      diag.info(
        `Host key ${prompt.status === 'mismatch' ? 'mismatch' : 'unknown'} for ${prompt.host} ${accept ? 'accepted' : 'rejected'}`,
        { code: prompt.status },
      );
    }
    setHostKeyPrompt(null);
    hostKeyResolverRef.current = null;
    resolver?.(accept);
  }, [hostKeyPrompt]);

  /**
   * Core connect routine shared by a fresh user-initiated `remoteConnect` and
   * the automatic reconnect triggered by `handleConnectionLost`. `retry`
   * carries context for an auto-reconnect attempt: when set, a failure here
   * is reported as a continuation of the original connection loss (not a
   * fresh connect error), and no further automatic retry is scheduled.
   */
  const performConnect = useCallback(
    (creds: RemoteCredentials, opts?: { retry?: { lostReason: string }; sessionId?: string }) => {
      const retry = opts?.retry;
      // A fresh connect (no sessionId) opens a NEW tab and keeps any current
      // session parked in the background; a reconnect reuses the dropped
      // session's id and reinstalls it in place. Nothing is closed here — the
      // prior active session is parked (still live) on success, or the dropped
      // session already tore itself down.
      const sessionId = opts?.sessionId ?? crypto.randomUUID();
      const isNewTab = !opts?.sessionId;

      setRemoteConnecting(true);
      if (!retry) setRemoteError(null);
      diag.info(`Connecting to ${remoteTarget(creds)}`);

      const trust = (info: { host: string; port: number; fingerprint: string; status: 'new' | 'match' | 'mismatch' }) => {
        // A remembered host key (status 'match') auto-accepts with no prompt —
        // this is what lets auto-reconnect proceed silently.
        if (info.status === 'match') return true;
        if (info.status === 'new') diag.warn(`New host key for ${info.host}:${info.port}`);
        if (info.status === 'mismatch') diag.warn(`Host key mismatch for ${info.host}:${info.port}`, { code: 'mismatch' });
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
        diag.error('Connect failed', { code: 'timeout', detail: 'Connection timed out after 30s.' });
        setHostKeyPrompt(null);
        hostKeyResolverRef.current = null;
      }, 30000);

      connectRemote(creds, {
        // Host-key trust + connection-lost/auto-reconnect apply to SSH (SFTP) only.
        trust: isSshProtocol(creds.protocol) ? trust : undefined,
        onClosed: isSshProtocol(creds.protocol)
          ? (reason) => handleSessionClosedRef.current(sessionId, reason)
          : undefined,
        channelWindow: getSettings().transferWindowMB * 1024 * 1024,
        label: remoteTarget(creds),
      }).then(
        (conn) => {
          window.clearTimeout(timer);
          if (settled) {
            // We already timed out/failed — don't leak this late-arriving session.
            void conn.close().catch(() => {});
            return;
          }
          settled = true;

          // New tab: park the currently-active session (still live) before we
          // overwrite the active slots with the new connection.
          const priorActiveId = activeSessionIdRef.current;
          if (isNewTab && priorActiveId && remoteConnRef.current && remoteFsRef.current) {
            const parked: ParkedSession = {
              id: priorActiveId,
              label: remoteLabelRef.current || priorActiveId,
              fs: remoteFsRef.current,
              home: remoteHomeRef.current,
              cwd: remoteCwdRef.current,
              selection: remoteSelectionRef.current,
              conn: remoteConnRef.current,
              creds: lastRemoteCredsRef.current,
              dropped: false,
            };
            setParkedSessions((prev) => [...prev, parked]);
          }

          remoteConnRef.current = conn;
          setRemote(conn.fs);
          setRemoteHome(conn.home);
          setRemoteCwd(conn.home);
          setRemoteSelection([]);
          activeSessionIdRef.current = sessionId;
          setActiveSessionId(sessionId);
          setSessionOrder((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
          setRemoteConnecting(false);
          setConnectDialogOpen(false);
          setRemoteError(null);
          lastRemoteCredsRef.current = creds;
          setCanReconnect(true);
          connectedAtRef.current = Date.now();
          diag.info(`Connected to ${conn.fs.label}`);
        },
        (e) => {
          window.clearTimeout(timer);
          if (settled) return;
          settled = true;
          setRemoteConnecting(false);
          const detail = describeError(e);
          diag.error('Connect failed', { code: errorCode(e), detail });
          if (retry) {
            // The auto-reconnect attempt itself failed. Auto-retries are
            // already exhausted (the counter was incremented before this
            // attempt started) — fall back to the manual connections view
            // instead of scheduling another automatic try.
            setRemoteError(`Connection lost: ${retry.lostReason}. Select a connection to reconnect.`);
          } else {
            setRemoteError(detail);
          }
          setHostKeyPrompt(null);
          hostKeyResolverRef.current = null;
        },
      );
    },
    [],
  );

  const remoteConnect = useCallback(
    (creds: RemoteCredentials) => {
      // A fresh, user-initiated connect always starts the auto-reconnect
      // budget over.
      reconnectAttemptsRef.current = 0;
      performConnect(creds);
    },
    [performConnect],
  );

  const handleSessionClosed = useCallback(
    (sessionId: string, reason: string) => {
      // A background (parked) session dropped: mark it so its tab shows the
      // state and its Reconnect becomes available; leave the active session and
      // its parked socket untouched (it already tore itself down).
      if (sessionId !== activeSessionIdRef.current) {
        setParkedSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, dropped: true } : s)),
        );
        return;
      }

      // The ACTIVE session dropped — the existing auto-reconnect flow.
      diag.error('Connection lost', { detail: reason });
      remoteConnRef.current = null;
      setRemote(null);

      // A connection that stayed up a while before dropping gets a fresh
      // auto-reconnect budget; a rapid flap keeps its (incremented) budget so it
      // stops auto-retrying and falls back to the manual view.
      const uptime = Date.now() - connectedAtRef.current;
      if (uptime >= STABLE_CONNECTION_MS) reconnectAttemptsRef.current = 0;

      const creds = lastRemoteCredsRef.current;
      if (creds && reconnectAttemptsRef.current < MAX_AUTO_RECONNECT_ATTEMPTS) {
        reconnectAttemptsRef.current += 1;
        setRemoteError('Connection lost — reconnecting…');
        // Reconnect the SAME session in place (reuse its id), so the tab
        // persists. The remembered host key auto-accepts ('match').
        performConnect(creds, { retry: { lostReason: reason }, sessionId });
      } else {
        setRemoteError(`Connection lost: ${reason}. Select a connection to reconnect.`);
      }
    },
    [performConnect],
  );

  useEffect(() => {
    handleSessionClosedRef.current = handleSessionClosed;
  }, [handleSessionClosed]);

  const reconnectLast = useCallback(() => {
    if (lastRemoteCredsRef.current) {
      remoteConnect(lastRemoteCredsRef.current);
    }
  }, [remoteConnect]);

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
        let secret: string | null;
        try {
          secret = await store.getSecret(id);
          touchVault();
        } catch {
          setRemoteError('Could not decrypt the saved secret — re-enter it.');
          return;
        }
        const sftpCreds: SftpCredentials = { host: conn.host, port: conn.port, username: conn.username };
        if (conn.authMethod === 'key' && secret) {
          try {
            const k = parseOpenSshPrivateKey(secret);
            sftpCreds.privateKey = { seed: k.seed, publicKey: k.publicKey };
          } catch {
            setRemoteError('Unsupported or invalid private key (encrypted keys are not yet supported).');
            return;
          }
        } else if (secret) {
          sftpCreds.password = secret;
        }
        // Saved connections are SFTP-only for now.
        remoteConnect({ protocol: 'sftp', ...sftpCreds });
        return;
      }

      // No stored secret, or the connection is marked "always prompt": open
      // the Connect dialog prefilled with the saved metadata so the user can
      // supply the secret by hand.
      openConnectDialogPrefilled({
        id: conn.id,
        name: conn.name,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        authMethod: conn.authMethod,
        alwaysPrompt: conn.alwaysPrompt,
      });
    },
    [store, vault, remoteConnect, openConnectDialogPrefilled, touchVault],
  );
  connectSavedRef.current = connectSaved;

  /** Install a parked session into the active slots (does not touch parkedSessions). */
  const activateParked = useCallback((sess: ParkedSession) => {
    remoteConnRef.current = sess.conn;
    setRemote(sess.fs);
    setRemoteHome(sess.home);
    setRemoteCwd(sess.cwd);
    setRemoteSelection(sess.selection);
    activeSessionIdRef.current = sess.id;
    setActiveSessionId(sess.id);
    lastRemoteCredsRef.current = sess.creds;
    setCanReconnect(!!sess.creds);
    setRemoteError(sess.dropped ? 'This session disconnected — reconnect to use it.' : null);
    reconnectAttemptsRef.current = 0;
  }, []);

  /** Clear the active slots to the "no remote" state (used when the last tab closes). */
  const clearActive = useCallback(() => {
    remoteConnRef.current = null;
    setRemote(null);
    setRemoteHome('/');
    setRemoteCwd('/');
    setRemoteSelection([]);
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
    lastRemoteCredsRef.current = null;
    setCanReconnect(false);
    reconnectAttemptsRef.current = 0;
  }, []);

  /** Switch to a parked session tab, parking the current active one. */
  const switchSession = useCallback(
    (id: string) => {
      if (id === activeSessionIdRef.current) return;
      const target = parkedSessionsRef.current.find((s) => s.id === id);
      if (!target) return;
      const activeId = activeSessionIdRef.current;
      const snapshot: ParkedSession | null =
        activeId && remoteConnRef.current && remoteFsRef.current
          ? {
              id: activeId,
              label: remoteLabelRef.current || activeId,
              fs: remoteFsRef.current,
              home: remoteHomeRef.current,
              cwd: remoteCwdRef.current,
              selection: remoteSelectionRef.current,
              conn: remoteConnRef.current,
              creds: lastRemoteCredsRef.current,
              dropped: false,
            }
          : null;
      setParkedSessions((prev) => {
        const without = prev.filter((s) => s.id !== id);
        return snapshot ? [...without, snapshot] : without;
      });
      activateParked(target);
    },
    [activateParked],
  );

  /** Close a session tab (active or parked), tearing down its connection. */
  const closeSession = useCallback(
    (id: string) => {
      setSessionOrder((prev) => prev.filter((s) => s !== id));
      if (id === activeSessionIdRef.current) {
        remoteConnRef.current?.close().catch(() => {});
        remoteConnRef.current = null;
        const next = parkedSessionsRef.current[parkedSessionsRef.current.length - 1];
        if (next) {
          setParkedSessions((prev) => prev.filter((s) => s.id !== next.id));
          activateParked(next);
        } else {
          clearActive();
          setRemoteError(null);
        }
        return;
      }
      // Parked tab: close its socket and drop it.
      const parked = parkedSessionsRef.current.find((s) => s.id === id);
      parked?.conn.close().catch(() => {});
      setParkedSessions((prev) => prev.filter((s) => s.id !== id));
    },
    [activateParked, clearActive],
  );

  /** Open the Connect dialog to start a new session (leaving current tabs open). */
  const openNewSession = useCallback(() => {
    setConnectDialogPrefill(null);
    setConnectDialogOpen(true);
  }, []);

  // Intentional disconnect of the active tab == closing that tab.
  const remoteDisconnect = useCallback(() => {
    const id = activeSessionIdRef.current;
    if (id) closeSession(id);
    else clearActive();
  }, [closeSession, clearActive]);

  // Transfers
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [conflictPrompt, setConflictPrompt] = useState<ConflictPromptState | null>(null);
  // A FIFO of pending conflicts — the queue runs with concurrency > 1, so more than
  // one job can hit a conflict at once. A single-slot resolver would let the 2nd
  // conflict overwrite the 1st's resolver, orphaning that job in 'conflict' forever
  // (its slot never frees). Serialize instead: one dialog at a time, in order.
  const conflictQueueRef = useRef<Array<{ name: string; resolve: (choice: ConflictChoice) => void }>>([]);
  const appliedChoiceRef = useRef<ConflictChoice | null>(null);

  const queue = useMemo(
    () =>
      new TransferQueue({
        pipelineDepth: () => getSettings().pipelineDepth,
        conflict: (job) =>
          new Promise<ConflictChoice>((resolve) => {
            if (appliedChoiceRef.current) {
              resolve(appliedChoiceRef.current);
              return;
            }
            conflictQueueRef.current.push({ name: job.name, resolve });
            if (conflictQueueRef.current.length === 1) setConflictPrompt({ name: job.name });
          }),
      }),
    [],
  );

  // Track which terminal job ids we've already logged to diagnostics, so a
  // job that emits multiple snapshots in the same terminal state (e.g. a
  // progress tick right before 'done') isn't logged more than once.
  const loggedJobIdsRef = useRef<Set<string>>(new Set());
  const [localRefreshNonce, setLocalRefreshNonce] = useState(0);
  const [remoteRefreshNonce, setRemoteRefreshNonce] = useState(0);

  useEffect(() => {
    return queue.subscribe((snapshot) => {
      setJobs(snapshot);
      const busy = snapshot.some((j) => j.state === 'queued' || j.state === 'active' || j.state === 'conflict');
      if (!busy) {
        // The whole batch is done — forget any "apply to all" choice and any
        // leftover pending conflicts (there shouldn't be any once idle, but this
        // is cheap hygiene against a stray future bug).
        appliedChoiceRef.current = null;
        conflictQueueRef.current = [];
      }
      for (const job of snapshot) {
        if (job.state === 'queued' || job.state === 'active') {
          // A retried job cycles back through these states — allow it to be
          // logged again if it reaches a terminal state a second time.
          loggedJobIdsRef.current.delete(job.id);
          continue;
        }
        if (loggedJobIdsRef.current.has(job.id)) continue;
        if (job.state === 'error') {
          diag.error(`Transfer failed: ${job.name}`, { detail: job.error });
          loggedJobIdsRef.current.add(job.id);
        } else if (job.state === 'done') {
          diag.info(`Transferred ${job.name}`);
          loggedJobIdsRef.current.add(job.id);
          // Refresh whichever pane received the file — 'up' (local→remote)
          // lands in remote, 'down' (remote→local) lands in local.
          if (job.direction === 'up') {
            setRemoteRefreshNonce((n) => n + 1);
          } else {
            setLocalRefreshNonce((n) => n + 1);
          }
        }
      }
    });
  }, [queue]);

  const resolveConflict = useCallback((choice: ConflictChoice, applyToAll: boolean) => {
    const head = conflictQueueRef.current.shift();
    head?.resolve(choice);
    if (applyToAll) {
      appliedChoiceRef.current = choice;
      const rest = conflictQueueRef.current;
      conflictQueueRef.current = [];
      rest.forEach((p) => p.resolve(choice));
      setConflictPrompt(null);
    } else {
      const next = conflictQueueRef.current[0];
      setConflictPrompt(next ? { name: next.name } : null);
    }
  }, []);

  const enqueueTransfer = useCallback(
    (opts: { from: 'local' | 'remote'; entries: FsEntry[]; toDir: string }) => {
      if (!local || !remote) return;
      const src = opts.from === 'local' ? local : remote;
      const dst = opts.from === 'local' ? remote : local;
      const direction = opts.from === 'local' ? 'up' : 'down';
      for (const entry of opts.entries) {
        queue.enqueue({
          name: entry.name,
          direction,
          src,
          srcPath: entry.path,
          dst,
          dstPath: joinPath(opts.toDir, entry.name),
          size: entry.size,
          isDir: entry.kind === 'dir',
        });
      }
    },
    [local, remote, queue],
  );

  const [syncOpen, setSyncOpen] = useState(false);
  const openSync = useCallback(() => setSyncOpen(true), []);
  const closeSync = useCallback(() => setSyncOpen(false), []);

  const cancelJob = useCallback((id: string) => queue.cancel(id), [queue]);
  const cancelAllJobs = useCallback(() => queue.cancelAll(), [queue]);
  const retryJob = useCallback((id: string) => queue.retry(id), [queue]);
  const clearFinished = useCallback(() => queue.clearFinished(), [queue]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const [localCwd, setLocalCwd] = useState('/');
  const [remoteCwd, setRemoteCwd] = useState(remoteHome);
  const [localSelection, setLocalSelection] = useState<FsEntry[]>([]);
  const [remoteSelection, setRemoteSelection] = useState<FsEntry[]>([]);

  // Mirror the active session's live values into refs so tab park/switch and the
  // onClosed router can snapshot them without stale closures.
  remoteCwdRef.current = remoteCwd;
  remoteSelectionRef.current = remoteSelection;
  remoteLabelRef.current = remote?.label ?? '';
  remoteFsRef.current = remote;
  remoteHomeRef.current = remoteHome;
  activeSessionIdRef.current = activeSessionId;
  // Note: remoteCwd is set explicitly at each install point (connect success,
  // tab switch, disconnect) rather than via an effect on remoteHome, so a
  // switched-back tab keeps its own saved cwd instead of snapping to home.

  // --- Synchronize (directory sync/mirror between the two panes' folders) ---
  const syncRoots = useCallback(
    (from: 'local' | 'remote') => {
      const src = from === 'local' ? local : remote;
      const dst = from === 'local' ? remote : local;
      const srcRoot = from === 'local' ? localCwd : remoteCwd;
      const dstRoot = from === 'local' ? remoteCwd : localCwd;
      return { src, dst, srcRoot, dstRoot };
    },
    [local, remote, localCwd, remoteCwd],
  );

  const previewSync = useCallback(
    async (req: SyncRequest): Promise<SyncSummary> => {
      const { src, dst, srcRoot, dstRoot } = syncRoots(req.from);
      if (!src || !dst) return { copy: 0, mkdir: 0, del: 0, bytes: 0, actions: [] };
      const actions = await computeSyncPlan(src, srcRoot, dst, dstRoot, {
        mode: req.mode,
        compareBy: req.compareBy,
      });
      return {
        actions,
        copy: actions.filter((a) => a.kind === 'copy').length,
        mkdir: actions.filter((a) => a.kind === 'mkdir').length,
        del: actions.filter((a) => a.kind === 'delete').length,
        bytes: planTotalBytes(actions),
      };
    },
    [syncRoots],
  );

  const applySync = useCallback(
    async (req: SyncRequest): Promise<void> => {
      const { src, dst, srcRoot, dstRoot } = syncRoots(req.from);
      if (!src || !dst) return;
      const direction = req.from === 'local' ? 'up' : 'down';

      // Ensure the destination root exists before creating anything under it.
      try {
        await dst.mkdir(dstRoot);
      } catch (e) {
        if (!(e instanceof FsError && e.code === 'exists')) throw e;
      }

      const actions = await computeSyncPlan(src, srcRoot, dst, dstRoot, {
        mode: req.mode,
        compareBy: req.compareBy,
      });

      // 1) Create directories (top-down; the plan is already ordered).
      for (const a of actions) {
        if (a.kind !== 'mkdir') continue;
        try {
          await dst.mkdir(a.dstPath);
        } catch (e) {
          if (!(e instanceof FsError && e.code === 'exists')) throw e;
        }
      }
      // 2) Queue the file copies (overwrite: the plan already decided these).
      for (const a of actions) {
        if (a.kind !== 'copy') continue;
        queue.enqueue({
          name: a.name,
          direction,
          src,
          srcPath: a.srcPath,
          dst,
          dstPath: a.dstPath,
          size: a.size,
          isDir: false,
          overwrite: true,
        });
      }
      // 3) Delete extraneous destination entries (mirror mode only produces these).
      for (const a of actions) {
        if (a.kind !== 'delete') continue;
        await dst.remove(a.dstPath, true);
      }

      // Copies refresh the destination pane on completion; mkdir/delete need a nudge.
      if (direction === 'up') setRemoteRefreshNonce((n) => n + 1);
      else setLocalRefreshNonce((n) => n + 1);
    },
    [syncRoots, queue],
  );

  const remoteSessions: RemoteSessionInfo[] = sessionOrder.map((id) => {
    if (id === activeSessionId) {
      return { id, label: remote?.label ?? id, active: true, dropped: false };
    }
    const p = parkedSessions.find((s) => s.id === id);
    return { id, label: p?.label ?? id, active: false, dropped: p?.dropped ?? false };
  });

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
    remoteSessions,
    activeSessionId,
    switchSession,
    closeSession,
    openNewSession,
    reconnectLast,
    canReconnect,
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
    jobs,
    conflictPrompt,
    resolveConflict,
    enqueueTransfer,
    canSync: !!(local && remote),
    syncOpen,
    openSync,
    closeSync,
    previewSync,
    applySync,
    cancelJob,
    cancelAllJobs,
    retryJob,
    clearFinished,
    localCwd,
    setLocalCwd,
    remoteCwd,
    setRemoteCwd,
    localSelection,
    setLocalSelection,
    remoteSelection,
    setRemoteSelection,
    localRefreshNonce,
    remoteRefreshNonce,
    settingsOpen,
    openSettings,
    closeSettings,
    vaultLockMinutes,
    setVaultLockMinutes,
    pipelineDepth,
    setPipelineDepth,
    transferWindowMB,
    setTransferWindowMB,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}
