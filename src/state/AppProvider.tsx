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
import { joinPath, type FileSystem, type FsEntry } from '../fs/FileSystem';
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
  remoteConnect: (creds: SftpCredentials) => void;
  remoteDisconnect: () => void;
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
  // The last credentials that produced a SUCCESSFUL connect, kept only for the
  // lifetime of this session/unlocked-vault (never persisted). Used to drive
  // auto-reconnect after an unexpected connection loss, and the manual
  // "Reconnect" affordance. Cleared on an intentional disconnect.
  const lastRemoteCredsRef = useRef<SftpCredentials | null>(null);
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
  const handleConnectionLostRef = useRef<(reason: string) => void>(() => {});

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
    (creds: SftpCredentials, retry?: { lostReason: string }) => {
      // Close any prior live connection before opening a new one, so switching
      // connections (or reconnecting) never leaves an orphaned host socket open.
      // On the auto-reconnect path the lost connection already tore itself down,
      // so this ref is null and there is nothing to close.
      const prior = remoteConnRef.current;
      remoteConnRef.current = null;
      if (prior) void prior.close().catch(() => {});

      setRemoteConnecting(true);
      if (!retry) setRemoteError(null);
      diag.info(`Connecting to ${creds.host}:${creds.port} as ${creds.username}`);

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
        diag.error('SFTP connect failed', { code: 'timeout', detail: 'Connection timed out after 30s.' });
        setHostKeyPrompt(null);
        hostKeyResolverRef.current = null;
      }, 30000);

      connectSftp(creds, trust, `${creds.username}@${creds.host}`, {
        onClosed: (reason) => handleConnectionLostRef.current(reason),
        channelWindow: getSettings().transferWindowMB * 1024 * 1024,
      }).then(
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
          diag.error('SFTP connect failed', { code: errorCode(e), detail });
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
    (creds: SftpCredentials) => {
      // A fresh, user-initiated connect always starts the auto-reconnect
      // budget over.
      reconnectAttemptsRef.current = 0;
      performConnect(creds);
    },
    [performConnect],
  );

  const handleConnectionLost = useCallback(
    (reason: string) => {
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
        // The remembered host key makes the trust callback auto-accept
        // ('match') below, so this proceeds without a host-key prompt.
        performConnect(creds, { lostReason: reason });
      } else {
        setRemoteError(`Connection lost: ${reason}. Select a connection to reconnect.`);
      }
    },
    [performConnect],
  );

  useEffect(() => {
    handleConnectionLostRef.current = handleConnectionLost;
  }, [handleConnectionLost]);

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

  const remoteDisconnect = useCallback(() => {
    remoteConnRef.current?.close().catch(() => {});
    remoteConnRef.current = null;
    setRemote(null);
    setRemoteHome('/');
    setRemoteError(null);
    // Intentional disconnect: forget the retained credentials so an
    // unexpected close afterwards (there shouldn't be one — the connection is
    // already torn down) never auto-reconnects, and the Reconnect affordance
    // disappears.
    lastRemoteCredsRef.current = null;
    setCanReconnect(false);
    reconnectAttemptsRef.current = 0;
  }, []);

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

  // Reset remote cwd to the connection's home directory whenever a new remote
  // session is established (remoteHome changes on connect).
  useEffect(() => {
    setRemoteCwd(remoteHome);
  }, [remoteHome]);

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
