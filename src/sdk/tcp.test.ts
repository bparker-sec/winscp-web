import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('ai-publish-sdk');
});

/** Mock the SDK with a tcp.connect that yields a socket whose receive() is
 * driven by the provided queue of behaviors. withTimeout passes straight
 * through so the inner receive rejection/resolution is what surfaces. */
function mockSdkWithReceives(behaviors: Array<() => Promise<string | null>>) {
  let i = 0;
  const socket = {
    send: vi.fn().mockResolvedValue(1),
    receive: vi.fn().mockImplementation(() => {
      const b = behaviors[Math.min(i, behaviors.length - 1)];
      i += 1;
      return b();
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  vi.doMock('ai-publish-sdk', () => ({
    tcp: { connect: vi.fn().mockResolvedValue(socket) },
    withTimeout: (fn: () => Promise<unknown>) => fn(),
  }));
  return socket;
}

const timeout = () => Promise.reject(new Error('timeout'));
const data = (s: string) => () => Promise.resolve(s);

describe('tcpConnect receive — idle tolerance', () => {
  it('retries past idle timeouts and returns the next real chunk (does not treat idle as dropped)', async () => {
    mockSdkWithReceives([timeout, timeout, data('aGk=')]);
    const { tcpConnect } = await import('./tcp');
    const res = await tcpConnect('h', 22);
    expect(res.ok).toBe(true);
    // Two idle windows elapse, then data arrives — receive() must resolve with it.
    expect(await res.socket!.receive()).toBe('aGk=');
  });

  it('declares the peer dead after enough consecutive idle timeouts', async () => {
    mockSdkWithReceives([timeout, timeout, timeout, timeout, timeout, timeout]);
    const { tcpConnect } = await import('./tcp');
    const res = await tcpConnect('h', 22);
    await expect(res.socket!.receive()).rejects.toThrow(/timed out|stopped responding/i);
  });

  it('resets the idle counter after data, so a later idle stretch is tolerated again', async () => {
    // idle, idle, idle, DATA (resets), idle, idle, idle, DATA — never 4-in-a-row.
    mockSdkWithReceives([
      timeout, timeout, timeout, data('QQ=='),
      timeout, timeout, timeout, data('Qg=='),
    ]);
    const { tcpConnect } = await import('./tcp');
    const res = await tcpConnect('h', 22);
    expect(await res.socket!.receive()).toBe('QQ==');
    expect(await res.socket!.receive()).toBe('Qg==');
  });

  it('propagates a non-timeout socket error immediately (no retry)', async () => {
    const reset = () => Promise.reject(new Error('connection reset by peer'));
    mockSdkWithReceives([reset, data('unused')]);
    const { tcpConnect } = await import('./tcp');
    const res = await tcpConnect('h', 22);
    await expect(res.socket!.receive()).rejects.toThrow(/reset/i);
  });

  it('returns null (peer closed) without retrying', async () => {
    mockSdkWithReceives([() => Promise.resolve(null)]);
    const { tcpConnect } = await import('./tcp');
    const res = await tcpConnect('h', 22);
    expect(await res.socket!.receive()).toBeNull();
  });
});
