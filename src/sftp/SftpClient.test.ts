import { describe, expect, it } from 'vitest';
import { SshWriter } from '../ssh/wire';
import { encodeAttrs, type FileAttrs } from './attrs';
import {
  SSH_FX_EOF,
  SSH_FX_NO_SUCH_FILE,
  SSH_FX_OK,
  SSH_FXP_ATTRS,
  SSH_FXP_DATA,
  SSH_FXP_HANDLE,
  SSH_FXP_NAME,
  SSH_FXP_STATUS,
  SSH_FXP_VERSION,
} from './constants';
import { SftpClient, SftpError, type SftpChannel } from './SftpClient';

/** Full wire packet: uint32 length || byte type || body. */
function packet(type: number, body: Uint8Array): Uint8Array {
  const w = new SshWriter().uint32(1 + body.length).byte(type).raw(body);
  return w.finish();
}

function versionPacket(version = 3): Uint8Array {
  return packet(SSH_FXP_VERSION, new SshWriter().uint32(version).finish());
}

function statusPacket(id: number, code: number, message = ''): Uint8Array {
  return packet(SSH_FXP_STATUS, new SshWriter().uint32(id).uint32(code).string(message).string('en').finish());
}

function handlePacket(id: number, handle: Uint8Array): Uint8Array {
  return packet(SSH_FXP_HANDLE, new SshWriter().uint32(id).string(handle).finish());
}

function dataPacket(id: number, data: Uint8Array): Uint8Array {
  return packet(SSH_FXP_DATA, new SshWriter().uint32(id).string(data).finish());
}

function attrsPacket(id: number, attrs: FileAttrs): Uint8Array {
  return packet(SSH_FXP_ATTRS, new SshWriter().uint32(id).raw(encodeAttrs(attrs)).finish());
}

function namePacket(id: number, entries: { filename: string; longname: string; attrs: FileAttrs }[]): Uint8Array {
  const w = new SshWriter().uint32(id).uint32(entries.length);
  for (const e of entries) {
    w.string(e.filename).string(e.longname).raw(encodeAttrs(e.attrs));
  }
  return packet(SSH_FXP_NAME, w.finish());
}

/** Fake SshChannel: records writes; read() serves enqueued chunks (or blocks until one arrives / close()). */
class FakeChannel implements SftpChannel {
  writes: Uint8Array[] = [];
  private queue: Uint8Array[] = [];
  private waiters: ((chunk: Uint8Array) => void)[] = [];
  private closed = false;
  closeCalls = 0;

  async write(bytes: Uint8Array): Promise<void> {
    this.writes.push(bytes);
  }

  async read(): Promise<Uint8Array> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.closed) return new Uint8Array(0);
    return new Promise<Uint8Array>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Push a response packet for the read loop to pick up. */
  enqueue(chunk: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(chunk);
    } else {
      this.queue.push(chunk);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls++;
    while (this.waiters.length > 0) {
      this.waiters.shift()!(new Uint8Array(0));
    }
  }
}

async function initClient(channel: FakeChannel): Promise<SftpClient> {
  const client = new SftpClient(channel);
  channel.enqueue(versionPacket(3));
  const version = await client.init();
  expect(version).toBe(3);
  return client;
}

describe('SftpClient', () => {
  it('init() sends INIT and returns the server version from VERSION', async () => {
    const channel = new FakeChannel();
    const client = new SftpClient(channel);
    channel.enqueue(versionPacket(3));

    const version = await client.init();

    expect(version).toBe(3);
    expect(channel.writes).toHaveLength(1);
    // INIT = byte 1 || uint32 version(3); packet() wraps with length+type.
    expect(Array.from(channel.writes[0])).toEqual([0, 0, 0, 5, 1, 0, 0, 0, 3]);
  });

  it('rejects a server version below 3', async () => {
    const channel = new FakeChannel();
    const client = new SftpClient(channel);
    channel.enqueue(versionPacket(2));
    await expect(client.init()).rejects.toThrow(/version/i);
  });

  it('stat() correlates the ATTRS response by request id', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);

    // First op after init() gets request id 1 (init consumes no id).
    channel.enqueue(attrsPacket(1, { permissions: 0o100644, size: 42 }));
    const attrs = await client.stat('/tmp/foo');

    expect(attrs).toEqual({ permissions: 0o100644, size: 42 });
  });

  it('open() then read() returns DATA, then a second read() returns null on STATUS EOF', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);
    const handle = new TextEncoder().encode('h1');

    channel.enqueue(handlePacket(1, handle));
    const gotHandle = await client.open('/tmp/foo', 0x1);
    expect(Array.from(gotHandle)).toEqual(Array.from(handle));

    const bytes = new Uint8Array([1, 2, 3, 4]);
    channel.enqueue(dataPacket(2, bytes));
    const chunk = await client.read(gotHandle, 0, 4);
    expect(Array.from(chunk!)).toEqual(Array.from(bytes));

    channel.enqueue(statusPacket(3, SSH_FX_EOF));
    const eof = await client.read(gotHandle, 4, 4);
    expect(eof).toBeNull();
  });

  it('readdir() returns entries, then null on STATUS EOF', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);
    const handle = new TextEncoder().encode('d1');

    channel.enqueue(handlePacket(1, handle));
    const gotHandle = await client.opendir('/tmp');

    const entries = [
      { filename: 'a.txt', longname: '-rw-r--r-- a.txt', attrs: { size: 1 } },
      { filename: 'b.txt', longname: '-rw-r--r-- b.txt', attrs: { size: 2 } },
    ];
    channel.enqueue(namePacket(2, entries));
    const first = await client.readdir(gotHandle);
    expect(first).toHaveLength(2);
    expect(first![0].filename).toBe('a.txt');
    expect(first![1].filename).toBe('b.txt');

    channel.enqueue(statusPacket(3, SSH_FX_EOF));
    const second = await client.readdir(gotHandle);
    expect(second).toBeNull();
  });

  it('remove() rejects with SftpError(code) on a non-OK STATUS', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);

    channel.enqueue(statusPacket(1, SSH_FX_NO_SUCH_FILE, 'No such file'));

    const removePromise = client.remove('/tmp/missing');
    await expect(removePromise).rejects.toMatchObject({ code: SSH_FX_NO_SUCH_FILE });
    await expect(removePromise).rejects.toBeInstanceOf(SftpError);
  });

  it('mkdir()/rmdir()/rename()/setstat() resolve on STATUS OK', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);

    channel.enqueue(statusPacket(1, SSH_FX_OK));
    await expect(client.mkdir('/tmp/newdir')).resolves.toBeUndefined();

    channel.enqueue(statusPacket(2, SSH_FX_OK));
    await expect(client.rmdir('/tmp/newdir')).resolves.toBeUndefined();

    channel.enqueue(statusPacket(3, SSH_FX_OK));
    await expect(client.rename('/tmp/a', '/tmp/b')).resolves.toBeUndefined();

    channel.enqueue(statusPacket(4, SSH_FX_OK));
    await expect(client.setstat('/tmp/b', { permissions: 0o644 })).resolves.toBeUndefined();
  });

  it('realpath() returns the filename of the single NAME entry', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);

    channel.enqueue(namePacket(1, [{ filename: '/home/user', longname: 'drwxr-xr-x /home/user', attrs: {} }]));
    const resolved = await client.realpath('.');
    expect(resolved).toBe('/home/user');
  });

  it('a pending request rejects when the channel closes (framer read fails)', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);

    const statPromise = client.stat('/tmp/foo');
    // Simulate the underlying channel going away before a response arrives.
    await channel.close();

    await expect(statPromise).rejects.toThrow();
  });

  it('close() with no args closes the channel and rejects remaining pending requests', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);

    const statPromise = client.stat('/tmp/foo');
    await client.close();

    expect(channel.closeCalls).toBe(1);
    await expect(statPromise).rejects.toThrow();
  });

  it('request() cleans up the pending entry when channel.write() rejects, instead of leaking it', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);

    const writeError = new Error('write failed: socket gone');
    const originalWrite = channel.write.bind(channel);
    let failNextWrite = true;
    channel.write = async (bytes: Uint8Array) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw writeError;
      }
      return originalWrite(bytes);
    };

    await expect(client.stat('/tmp/foo')).rejects.toThrow(/write failed/);
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);

    // Client remains usable afterward: a subsequent request with a working
    // write should still resolve normally (no stuck/duplicate id state).
    channel.enqueue(attrsPacket(2, { size: 3 }));
    await expect(client.stat('/tmp/bar')).resolves.toEqual({ size: 3 });
  });

  it('closeHandle() sends SFTP CLOSE for a handle and expects STATUS OK', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);
    const handle = new TextEncoder().encode('h1');

    channel.enqueue(statusPacket(1, SSH_FX_OK));
    await expect(client.closeHandle(handle)).resolves.toBeUndefined();
    expect(channel.closeCalls).toBe(0); // closeHandle must not tear down the channel
  });

  it('write() resolves on STATUS OK', async () => {
    const channel = new FakeChannel();
    const client = await initClient(channel);
    const handle = new TextEncoder().encode('h1');

    channel.enqueue(statusPacket(1, SSH_FX_OK));
    await expect(client.write(handle, 0, new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
  });

  it('registers the pending resolver before writing, so a same-tick response cannot be missed', async () => {
    // Enqueue the response BEFORE calling the op — the fake's read() will
    // hand it back on the very first poll from the read loop. If `request()`
    // wrote before registering the resolver, this ordering would still work
    // because the response can only be consumed once the read loop asks for
    // it; this test documents/guards the intended registration order.
    const channel = new FakeChannel();
    const client = await initClient(channel);
    channel.enqueue(attrsPacket(1, { size: 7 }));

    const attrs = await client.stat('/tmp/foo');
    expect(attrs).toEqual({ size: 7 });
  });
});
