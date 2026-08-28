import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppProvider, useApp } from './AppProvider';
import { connectSftp } from '../sftp/SftpConnection';
import { rememberHost } from '../ssh/knownhosts';

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

const mockConnectSftp = connectSftp as unknown as ReturnType<typeof vi.fn>;
const mockRememberHost = rememberHost as unknown as ReturnType<typeof vi.fn>;

function setupHook() {
  return renderHook(() => useApp(), {
    wrapper: ({ children }) => <AppProvider>{children}</AppProvider>,
  });
}

const creds = { host: 'example.com', port: 22, username: 'bob', password: 'hunter2' };

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
