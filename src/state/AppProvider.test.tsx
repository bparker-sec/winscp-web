import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppProvider, useApp } from './AppProvider';
import { connectSftp } from '../sftp/SftpConnection';
import { rememberHost } from '../ssh/knownhosts';
import { connectOneDrive } from '../onedrive/auth';
import { MockFS } from '../fs/MockFS';
import type { FileSystem } from '../fs/FileSystem';

vi.mock('../sftp/SftpConnection', () => ({
  connectSftp: vi.fn(),
}));

vi.mock('../ssh/knownhosts', () => ({
  rememberHost: vi.fn(),
}));

vi.mock('../onedrive/auth', () => ({
  oneDriveAuth: {},
  connectOneDrive: vi.fn(async () => ({ ok: false, reason: 'blocked' })),
  clearOneDriveSession: vi.fn(async () => true),
  trySilentOneDrive: vi.fn(async () => false),
}));

vi.mock('../sdk/client', () => ({
  sdkGetUser: vi.fn(async () => null),
}));

// The conflict-wiring tests below need a real, working "local" FileSystem
// (enqueueTransfer no-ops unless both local and remote are non-null). Rather
// than exercise the real OneDrive Graph client, swap in a plain MockFS instance
// whenever the provider constructs its OneDriveFS.
let localFsForOneDriveMock: FileSystem = new MockFS('local');
vi.mock('../onedrive/OneDriveFS', () => ({
  OneDriveFS: vi.fn().mockImplementation(() => localFsForOneDriveMock),
}));

const mockConnectSftp = connectSftp as unknown as ReturnType<typeof vi.fn>;
const mockRememberHost = rememberHost as unknown as ReturnType<typeof vi.fn>;
const mockConnectOneDrive = connectOneDrive as unknown as ReturnType<typeof vi.fn>;

function setupHook() {
  return renderHook(() => useApp(), {
    wrapper: ({ children }) => <AppProvider>{children}</AppProvider>,
  });
}

const creds = { protocol: 'sftp' as const, host: 'example.com', port: 22, username: 'bob', password: 'hunter2' };

describe('AppProvider remote connection state machine', () => {
  beforeEach(() => {
    mockConnectSftp.mockReset();
    mockRememberHost.mockReset();
  });

  it('successful remote connect sets remote/remoteHome and clears connecting', async () => {
    const fakeFs = { label: 'bob@example.com' };
    const close = vi.fn(async () => {});
    mockConnectSftp.mockResolvedValue({ fs: fakeFs, fingerprint: 'SHA256:x', home: '/home/u', close });

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });

    expect(result.current.remoteConnecting).toBe(true);

    await waitFor(() => {
      expect(result.current.remote).toBe(fakeFs);
    });

    expect(result.current.remoteHome).toBe('/home/u');
    expect(result.current.remoteConnecting).toBe(false);
    expect(result.current.connectDialogOpen).toBe(false);
  });

  it('host-key prompt flow: accept remembers host and completes the connect', async () => {
    const fakeFs = { label: 'bob@example.com' };
    const close = vi.fn(async () => {});

    mockConnectSftp.mockImplementation(async (_creds, trust) => {
      const accepted = await trust({ host: 'example.com', port: 22, fingerprint: 'SHA256:new', status: 'new' });
      if (!accepted) throw new Error('host key rejected');
      return { fs: fakeFs, fingerprint: 'SHA256:new', home: '/home/u', close };
    });

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });

    await waitFor(() => {
      expect(result.current.hostKeyPrompt).not.toBeNull();
    });
    expect(result.current.hostKeyPrompt?.host).toBe('example.com:22');
    expect(result.current.hostKeyPrompt?.fingerprint).toBe('SHA256:new');

    act(() => {
      result.current.resolveHostKey(true);
    });

    expect(mockRememberHost).toHaveBeenCalledWith('example.com', 22, 'SHA256:new');

    await waitFor(() => {
      expect(result.current.remote).toBe(fakeFs);
    });
    expect(result.current.hostKeyPrompt).toBeNull();
  });

  it('reject host key: connectSftp rejects, remoteError is set, remote stays null', async () => {
    mockConnectSftp.mockImplementation(async (_creds, trust) => {
      const accepted = await trust({ host: 'example.com', port: 22, fingerprint: 'SHA256:new', status: 'new' });
      if (!accepted) throw new Error('SSH host key was not trusted by the caller.');
      throw new Error('unreachable');
    });

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });

    await waitFor(() => {
      expect(result.current.hostKeyPrompt).not.toBeNull();
    });

    act(() => {
      result.current.resolveHostKey(false);
    });

    expect(mockRememberHost).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(result.current.remoteError).toMatch(/not trusted/i);
    });
    expect(result.current.remote).toBeNull();
    expect(result.current.hostKeyPrompt).toBeNull();
  });

  it('connect failure sets remoteError, clears remoteConnecting/hostKeyPrompt', async () => {
    mockConnectSftp.mockRejectedValue(new Error('boom'));

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });

    await waitFor(() => {
      expect(result.current.remoteError).toBe('boom');
    });
    expect(result.current.remoteConnecting).toBe(false);
    expect(result.current.hostKeyPrompt).toBeNull();
    expect(result.current.remote).toBeNull();
  });

  it('disconnect closes the connection and clears remote/remoteHome', async () => {
    const fakeFs = { label: 'bob@example.com' };
    const close = vi.fn(async () => {});
    mockConnectSftp.mockResolvedValue({ fs: fakeFs, fingerprint: 'SHA256:x', home: '/home/u', close });

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });

    await waitFor(() => {
      expect(result.current.remote).toBe(fakeFs);
    });

    act(() => {
      result.current.remoteDisconnect();
    });

    expect(close).toHaveBeenCalled();
    expect(result.current.remote).toBeNull();
    expect(result.current.remoteHome).toBe('/');
  });

  it('timeout-then-late-success: a connection that resolves after the timeout is closed, not stored', async () => {
    vi.useFakeTimers();
    const fakeFs = { label: 'bob@example.com' };
    const close = vi.fn(async () => {});

    let resolveConnect: (conn: unknown) => void;
    mockConnectSftp.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    );

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });

    // Advance past the 30s timeout.
    await act(async () => {
      vi.advanceTimersByTime(30001);
    });

    expect(result.current.remoteError).toMatch(/timed out/i);
    expect(result.current.remoteConnecting).toBe(false);

    // Now the connect "arrives late" after we already gave up.
    await act(async () => {
      resolveConnect!({ fs: fakeFs, fingerprint: 'SHA256:x', home: '/home/u', close });
      // let the .then handler run
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(close).toHaveBeenCalled();
    expect(result.current.remote).toBeNull();

    vi.useRealTimers();
  });
});

describe('AppProvider auto-reconnect on connection loss', () => {
  beforeEach(() => {
    mockConnectSftp.mockReset();
    mockRememberHost.mockReset();
  });

  it('auto-reconnects once (no host-key prompt) after an unexpected close, then resets the retry budget', async () => {
    const fakeFs = { label: 'bob@example.com' };
    const close = vi.fn(async () => {});
    let onClosed: ((reason: string) => void) | undefined;

    mockConnectSftp.mockImplementation(async (_creds, _trust, _label, opts) => {
      onClosed = opts?.onClosed;
      return { fs: fakeFs, fingerprint: 'SHA256:x', home: '/home/u', close };
    });

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });
    await waitFor(() => expect(result.current.remote).toBe(fakeFs));
    expect(result.current.canReconnect).toBe(true);

    // Simulate the transport dropping the connection.
    act(() => {
      onClosed?.('socket closed');
    });

    expect(result.current.remote).toBeNull();
    expect(result.current.remoteError).toMatch(/reconnecting/i);

    // The auto-reconnect call must not prompt for the host key (it reuses
    // connectSftp, which auto-accepts a 'match' host key with no prompt).
    await waitFor(() => expect(result.current.remote).toBe(fakeFs));
    expect(result.current.hostKeyPrompt).toBeNull();
    expect(mockConnectSftp).toHaveBeenCalledTimes(2);
  });

  it('falls back to the connections view without looping after the auto-retry also fails', async () => {
    const fakeFs = { label: 'bob@example.com' };
    const close = vi.fn(async () => {});
    let onClosed: ((reason: string) => void) | undefined;
    let calls = 0;

    mockConnectSftp.mockImplementation(async (_creds, _trust, _label, opts) => {
      calls++;
      if (calls === 1) {
        onClosed = opts?.onClosed;
        return { fs: fakeFs, fingerprint: 'SHA256:x', home: '/home/u', close };
      }
      throw new Error('connection refused');
    });

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });
    await waitFor(() => expect(result.current.remote).toBe(fakeFs));

    act(() => {
      onClosed?.('socket closed');
    });

    await waitFor(() => {
      expect(result.current.remoteError).toMatch(/connection lost/i);
      expect(result.current.remoteError).toMatch(/select a connection/i);
    });
    expect(result.current.remote).toBeNull();
    // Exactly one auto-retry was attempted (initial connect + one retry), no loop.
    expect(mockConnectSftp).toHaveBeenCalledTimes(2);
    // Retained creds are still available for a manual Reconnect click.
    expect(result.current.canReconnect).toBe(true);
  });

  it('an intentional disconnect clears retained creds so a later close does not auto-reconnect', async () => {
    const fakeFs = { label: 'bob@example.com' };
    const close = vi.fn(async () => {});
    mockConnectSftp.mockResolvedValue({ fs: fakeFs, fingerprint: 'SHA256:x', home: '/home/u', close });

    const { result } = setupHook();

    act(() => {
      result.current.remoteConnect(creds);
    });
    await waitFor(() => expect(result.current.remote).toBe(fakeFs));

    act(() => {
      result.current.remoteDisconnect();
    });

    expect(result.current.canReconnect).toBe(false);
    expect(result.current.remoteError).toBeNull();
  });
});

describe('AppProvider conflict-resolver wiring', () => {
  beforeEach(() => {
    mockConnectSftp.mockReset();
    mockRememberHost.mockReset();
    mockConnectOneDrive.mockReset();
    localFsForOneDriveMock = new MockFS('local');
  });

  /** Signs in "local" (a MockFS) and connects "remote" (another MockFS), both seeded identically. */
  async function connectBothSides() {
    mockConnectOneDrive.mockResolvedValue({ ok: true });
    const remoteFs = new MockFS('remote');
    const close = vi.fn(async () => {});
    mockConnectSftp.mockResolvedValue({ fs: remoteFs, fingerprint: 'SHA256:x', home: '/', close });

    const { result } = setupHook();

    act(() => {
      result.current.connect();
    });
    await waitFor(() => expect(result.current.local).not.toBeNull());

    act(() => {
      result.current.remoteConnect({ protocol: 'sftp', host: 'example.com', port: 22, username: 'bob', password: 'x' });
    });
    await waitFor(() => expect(result.current.remote).not.toBeNull());

    return result;
  }

  it('a single conflict: resolveConflict(overwrite, false) lets the job complete', async () => {
    const result = await connectBothSides();

    const entry = await result.current.local!.stat('/readme.md');
    act(() => {
      result.current.enqueueTransfer({ from: 'local', entries: [entry], toDir: '/' });
    });

    await waitFor(() => expect(result.current.conflictPrompt).not.toBeNull());
    expect(result.current.conflictPrompt?.name).toBe('readme.md');

    act(() => {
      result.current.resolveConflict('overwrite', false);
    });

    await waitFor(() => {
      const job = result.current.jobs.find((j) => j.name === 'readme.md');
      expect(job?.state).toBe('done');
    });
    expect(result.current.conflictPrompt).toBeNull();
  });

  it('two conflicting jobs: the second conflict prompt shows only after the first is resolved', async () => {
    const result = await connectBothSides();

    const notes = await result.current.local!.stat('/Documents/notes.txt');
    const budget = await result.current.local!.stat('/Documents/budget.xlsx');
    act(() => {
      result.current.enqueueTransfer({ from: 'local', entries: [notes, budget], toDir: '/Documents' });
    });

    await waitFor(() => expect(result.current.conflictPrompt).not.toBeNull());
    const firstName = result.current.conflictPrompt?.name;
    expect(['notes.txt', 'budget.xlsx']).toContain(firstName);

    act(() => {
      result.current.resolveConflict('overwrite', false);
    });

    await waitFor(() => {
      expect(result.current.conflictPrompt).not.toBeNull();
      expect(result.current.conflictPrompt?.name).not.toBe(firstName);
    });
    const secondName = result.current.conflictPrompt!.name;
    expect(['notes.txt', 'budget.xlsx']).toContain(secondName);
    expect(secondName).not.toBe(firstName);

    act(() => {
      result.current.resolveConflict('overwrite', false);
    });

    await waitFor(() => {
      expect(result.current.jobs.every((j) => j.state === 'done')).toBe(true);
    });
    expect(result.current.conflictPrompt).toBeNull();
  });
});

describe('AppProvider destination-pane auto-refresh on transfer completion', () => {
  beforeEach(() => {
    mockConnectSftp.mockReset();
    mockRememberHost.mockReset();
    mockConnectOneDrive.mockReset();
    localFsForOneDriveMock = new MockFS('local');
  });

  async function connectBothSides() {
    mockConnectOneDrive.mockResolvedValue({ ok: true });
    const remoteFs = new MockFS('remote');
    const close = vi.fn(async () => {});
    mockConnectSftp.mockResolvedValue({ fs: remoteFs, fingerprint: 'SHA256:x', home: '/', close });

    const { result } = setupHook();

    act(() => {
      result.current.connect();
    });
    await waitFor(() => expect(result.current.local).not.toBeNull());

    act(() => {
      result.current.remoteConnect({ protocol: 'sftp', host: 'example.com', port: 22, username: 'bob', password: 'x' });
    });
    await waitFor(() => expect(result.current.remote).not.toBeNull());

    return result;
  }

  it('an upload (direction "up") that completes bumps remoteRefreshNonce only', async () => {
    const result = await connectBothSides();
    const startingLocal = result.current.localRefreshNonce;
    const startingRemote = result.current.remoteRefreshNonce;

    const entry = await result.current.local!.stat('/readme.md');
    act(() => {
      result.current.enqueueTransfer({ from: 'local', entries: [entry], toDir: '/upload-dst' });
    });

    await waitFor(() => {
      const job = result.current.jobs.find((j) => j.name === 'readme.md');
      expect(job?.state).toBe('done');
    });

    expect(result.current.remoteRefreshNonce).toBe(startingRemote + 1);
    expect(result.current.localRefreshNonce).toBe(startingLocal);
  });

  it('a download (direction "down") that completes bumps localRefreshNonce only', async () => {
    const result = await connectBothSides();
    const startingLocal = result.current.localRefreshNonce;
    const startingRemote = result.current.remoteRefreshNonce;

    const entry = await result.current.remote!.stat('/readme.md');
    act(() => {
      result.current.enqueueTransfer({ from: 'remote', entries: [entry], toDir: '/download-dst' });
    });

    await waitFor(() => {
      const job = result.current.jobs.find((j) => j.name === 'readme.md');
      expect(job?.state).toBe('done');
    });

    expect(result.current.localRefreshNonce).toBe(startingLocal + 1);
    expect(result.current.remoteRefreshNonce).toBe(startingRemote);
  });

  it('bumps the nonce exactly once per completion, not once per progress emission', async () => {
    const result = await connectBothSides();
    const startingRemote = result.current.remoteRefreshNonce;

    const entry = await result.current.local!.stat('/readme.md');
    act(() => {
      result.current.enqueueTransfer({ from: 'local', entries: [entry], toDir: '/upload-dst2' });
    });

    await waitFor(() => {
      const job = result.current.jobs.find((j) => j.name === 'readme.md');
      expect(job?.state).toBe('done');
    });

    // Let any further queue snapshots (e.g. idle cleanup) flush.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.remoteRefreshNonce).toBe(startingRemote + 1);
  });

  it('a retried job that fails then completes bumps the nonce once, on the eventual done', async () => {
    const result = await connectBothSides();
    const startingRemote = result.current.remoteRefreshNonce;

    // Force the first attempt to error (openWrite throws once), so the job
    // reaches 'error' before a retry lets the (now-unpatched) real openWrite
    // succeed.
    const dst = result.current.remote!;
    vi.spyOn(dst, 'openWrite').mockImplementationOnce(() => {
      throw new Error('injected failure');
    });

    const entry = await result.current.local!.stat('/readme.md');
    act(() => {
      result.current.enqueueTransfer({ from: 'local', entries: [entry], toDir: '/upload-dst3' });
    });

    await waitFor(() => {
      const job = result.current.jobs.find((j) => j.name === 'readme.md');
      expect(job?.state).toBe('error');
    });
    // The failed attempt must not have bumped the destination nonce.
    expect(result.current.remoteRefreshNonce).toBe(startingRemote);

    const jobId = result.current.jobs.find((j) => j.name === 'readme.md')!.id;
    act(() => {
      result.current.retryJob(jobId);
    });

    await waitFor(() => {
      const job = result.current.jobs.find((j) => j.id === jobId);
      expect(job?.state).toBe('done');
    });

    expect(result.current.remoteRefreshNonce).toBe(startingRemote + 1);
  });
});
