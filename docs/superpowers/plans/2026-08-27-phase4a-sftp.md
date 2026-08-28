# WinSCP Web — Plan 4a: SFTP Protocol, Client & SftpFS

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with a spec reviewer + code-quality reviewer per major step. Steps use checkbox (`- [ ]`).

**Goal:** Implement the SFTP v3 protocol over the (live-verified) `SshChannel` duplex, expose it as an async `SftpClient`, and implement `SftpFS implements FileSystem` — then validate every operation against a real SFTP server via the harness. This makes the remote side a real, working file system; the UI wiring is Plan 4b.

**Depends on:** Phase 3 (`SshClient.openSubsystem('sftp')` → `SshChannel` with `write/read/close`), `src/fs/FileSystem.ts` (the seam: `FsError`, `FsEntry`, streaming `ReadHandle`/`WriteHandle`). No changes to those.

**Scope:** SFTP protocol **version 3** (OpenSSH's dialect). Operations: init, open/read/write/close, opendir/readdir, mkdir/rmdir, remove, rename, stat/lstat, realpath, setstat (chmod). **Deferred:** symlink/readlink, extended requests, resume, SFTP v4+.

## SFTP v3 protocol reference (implement exactly — RFC draft-ietf-secsh-filexfer-02)

**Packet framing:** every SFTP packet = `uint32 length || byte type || <payload>` where `length` counts `type + payload`. Reassembly: the `SshChannel.read()` yields arbitrary channel chunks, so buffer them and slice out complete `length`-prefixed packets.

**Message types:** INIT=1, VERSION=2, OPEN=3, CLOSE=4, READ=5, WRITE=6, LSTAT=7, FSTAT=8, SETSTAT=9, FSETSTAT=10, OPENDIR=11, READDIR=12, REMOVE=13, MKDIR=14, RMDIR=15, REALPATH=16, STAT=17, RENAME=18, READLINK=19, SYMLINK=20; responses STATUS=101, HANDLE=102, DATA=103, NAME=104, ATTRS=105.

**INIT/VERSION** (special — no request id): INIT = `byte 1 || uint32 version(3)`. VERSION = `byte 2 || uint32 version || extension-pairs...`. All OTHER packets carry `uint32 request-id` right after the type.

**ATTRS** (`uint32 flags` then optional fields in this order): SIZE(0x1)→`uint64 size`; UIDGID(0x2)→`uint32 uid, uint32 gid`; PERMISSIONS(0x4)→`uint32 permissions`; ACMODTIME(0x8)→`uint32 atime, uint32 mtime`; EXTENDED(0x80000000)→`uint32 count` then count×(string type, string data). Encoder for requests that send attrs (MKDIR/SETSTAT): write `flags` then only the flagged fields. An empty attrs = `uint32 0`.

**STATUS** = `uint32 id || uint32 code || string message || string language`. Codes: OK=0, EOF=1, NO_SUCH_FILE=2, PERMISSION_DENIED=3, FAILURE=4, BAD_MESSAGE=5, NO_CONNECTION=6, CONNECTION_LOST=7, OP_UNSUPPORTED=8.
**HANDLE** = `uint32 id || string handle`. **DATA** = `uint32 id || string data`. **NAME** = `uint32 id || uint32 count || count×(string filename, string longname, ATTRS)`. **ATTRS response** = `uint32 id || ATTRS`.

**Requests:**
- OPEN = `uint32 id || string filename || uint32 pflags || ATTRS`. pflags: READ=0x1, WRITE=0x2, APPEND=0x4, CREAT=0x8, TRUNC=0x10, EXCL=0x20.
- CLOSE/READDIR = `uint32 id || string handle`. OPENDIR/REMOVE/RMDIR/STAT/LSTAT/REALPATH = `uint32 id || string path`.
- READ = `uint32 id || string handle || uint64 offset || uint32 length`.
- WRITE = `uint32 id || string handle || uint64 offset || string data`.
- MKDIR = `uint32 id || string path || ATTRS`. SETSTAT = `uint32 id || string path || ATTRS`.
- RENAME = `uint32 id || string oldpath || string newpath`.

**Semantics:** READDIR is called repeatedly until the server replies STATUS(EOF). READ returns DATA or STATUS(EOF) at end of file. Path separators are `/`. `REALPATH(".")` resolves the home/start directory.

## File Structure
- `src/sftp/constants.ts` — message types, attr flags, pflags, status codes
- `src/sftp/attrs.ts` (+test) — ATTRS encode/decode ↔ a typed `FileAttrs`
- `src/sftp/protocol.ts` (+test) — request builders + response parsers (STATUS/HANDLE/DATA/NAME/ATTRS)
- `src/sftp/framing.ts` (+test) — SFTP packet reassembly over a chunk source
- `src/sftp/SftpClient.ts` (+test) — request-id correlation over an SshChannel; async ops + `SftpError`
- `src/sftp/SftpFS.ts` (+test) — `FileSystem` implementation
- `src/sftp/SftpConnection.ts` — glue: tcp → SshClient → openSubsystem → SftpClient.init → SftpFS
- extend `scripts/ssh-verify.mts` — live SFTP ops

## Milestones (implementer + spec review + code-quality review each)

- **M1 — constants + attrs + framing.** `constants.ts`; `attrs.ts` (encode/decode `FileAttrs { size?, uid?, gid?, permissions?, atime?, mtime? }` — decode reads only flagged fields IN ORDER; encode sets flags for present fields; test round-trip incl. permissions-only and size+perms+mtime, and the empty-attrs `uint32 0` case, and that unknown EXTENDED blocks are skipped on decode). `framing.ts`: a `SftpFramer` that takes an async chunk source (`() => Promise<Uint8Array>`, i.e. `channel.read`) and yields complete SFTP packets `{ type, body }` (body = bytes after the type byte); test by feeding a fake source that returns a packet split across two chunks and two packets in one chunk — assert correct depacketization; enforce a max length (e.g. reuse the idea of a sane cap) to avoid runaway.

- **M2 — protocol builders/parsers.** `protocol.ts` uses `SshWriter`/`SshReader` + `attrs.ts`. Builders (each takes an id + args, returns the full SFTP packet incl. the `uint32 length` prefix): `buildInit()`, `buildOpen`, `buildClose`, `buildRead`, `buildWrite`, `buildOpenDir`, `buildReadDir`, `buildRemove`, `buildMkdir`, `buildRmdir`, `buildRealpath`, `buildStat`, `buildLstat`, `buildRename`, `buildSetstat`. Parsers on a packet `{type, body}`: `parseVersion` (→version), `parseStatus` (→{id,code,message}), `parseHandle` (→{id,handle}), `parseData` (→{id,data}), `parseName` (→{id, entries:[{filename, longname, attrs}]}), `parseAttrs` (→{id, attrs}). Tests: exact bytes for a couple of builders (OPEN pflags+attrs, READ offset/length, RENAME), and round-trip a NAME/STATUS/HANDLE/DATA/ATTRS through build-in-test → parse. Cover the READDIR-EOF STATUS path.

- **M3 — SftpClient.** `SftpClient` wraps an `SshChannel` + a `SftpFramer`. On construction it does NOT init; expose `async init(): Promise<number>` (send INIT, read VERSION, assert v≥3, return server version). A private incrementing request-id counter; a `Map<id, {resolve,reject}>`; a background loop reading packets from the framer and resolving the matching pending request by id (STATUS with code≠OK/EOF → reject with `SftpError(code,message)`; the waiter decides whether EOF is an error). Async ops returning typed results: `open(path,pflags,attrs?)→handle`, `close(handle)`, `read(handle,offset,length)→Uint8Array|null(EOF)`, `write(handle,offset,data)`, `opendir(path)→handle`, `readdir(handle)→entries|null(EOF)`, `remove/mkdir/rmdir/rename/setstat`, `stat/lstat(path)→FileAttrs`, `realpath(path)→string`. `SftpError extends Error { code }`. Tests with a FAKE SshChannel (records writes, lets the test push response packets): drive `stat`→ATTRS, `open`→HANDLE, `read`→DATA then EOF, `readdir`→NAME then EOF, and a `remove` that gets STATUS(NO_SUCH_FILE) → rejects with SftpError code 2.

- **M4 — SftpFS.** `SftpFS implements FileSystem` over an `SftpClient`. Map SFTP status → FsError (NO_SUCH_FILE→'not-found', PERMISSION_DENIED→'permission', code 4 FAILURE on an existing mkdir→'exists' is ambiguous; map FAILURE→'io' generally, but mkdir/rename can check-then-act if needed — keep it simple: FAILURE→'io'). Methods: `list(path)` = opendir→readdir loop→close, map each entry (skip `.`/`..`) via attrs→FsEntry (name, path=joinPath, kind from permissions S_IFDIR 0o40000 / S_IFLNK 0o120000 else file, size, mtime=attrs.mtime*1000, mode=permissions&0o7777). `stat(path)` = SFTP stat→FsEntry (kind from perms). `mkdir` = MKDIR empty attrs. `rename`/`move` = RENAME. `remove(path,recursive)`: stat; if dir and !recursive and non-empty (list) → FsError('not-empty'); if dir → recursively remove children then RMDIR; else REMOVE. `openRead(path)` = OPEN(READ)→ReadHandle whose `read(into)` issues READ at an offset (advance by returned length; EOF→0) and `close()`=CLOSE. `openWrite(path,size?)` = OPEN(WRITE|CREAT|TRUNC)→WriteHandle whose `write(chunk)` issues WRITE at an advancing offset, `close()`=CLOSE, `abort()`=CLOSE (best-effort; partial file remains — note it). `chmod(path,mode)` = SETSTAT with permissions. Tests with a FAKE SftpClient (in-memory): list/stat mapping, remove recursive guard, openRead offset advance + EOF, openWrite offset advance, error mapping (NO_SUCH_FILE→not-found).

- **M5 — SftpConnection + LIVE verification.** `SftpConnection.connect({host,port,username,privateKey?/password?, trust})`: `tcpConnect` → `ByteStream` → `SshClient.connect(trust)` → `authenticate` → `openSubsystem('sftp')` → `new SftpClient(channel)` + `init()` → `new SftpFS(client, label)`; return `{ fs, fingerprint, home: await client.realpath('.') , close() }`. Then extend `scripts/ssh-verify.mts` (or add `scripts/sftp-verify.mts`) to, against the live server: `realpath('.')`, `list(home)`, `mkdir(home + '/winscp-web-test')`, `openWrite` a small file + `openRead` it back and compare bytes, `stat` it, `rename` it, `remove` it and the dir — printing each ✓. Run it live and paste the transcript. Then `npm run build` (exit 0, static; harness excluded).

## Testing strategy
- Pure/framing/protocol units for M1–M2; fake-channel unit tests for M3; fake-client unit tests for M4.
- **Live end-to-end** SFTP round-trip (M5) is the authoritative gate — a real server's attrs/status/handle behavior can't be fully faked. Reuse the Node harness pattern from Phase 3.

## Self-review checklist
- ATTRS decode reads flagged fields in the exact order; length prefix on every SFTP packet counts type+payload.
- request-id correlation: no two in-flight requests share an id; the read loop rejects all pending on channel close.
- READ/WRITE offsets advance by actual bytes; readdir loops until EOF; recursive remove guards non-empty dirs.
- SFTP status → FsError mapping consistent; harness excluded from bundle + vitest.
