# WinSCP Web — Phase 1 Design

**Date:** 2026-08-27
**Status:** Approved (brainstorming)
**Phase:** 1 of N — App skeleton + OneDrive local pane + transfer engine + saved-connections manager + **SFTP** (in-browser SSH stack)

## 1. Purpose & Context

A browser-delivered, WinSCP-style file transfer client that runs **entirely client-side** as a
static SPA / PWA inside the Island browser (delivered via the AI app host). It has **no backend we
control** and **never writes to the local disk** for the "local" side of a transfer. Instead:

- The **local side is Microsoft OneDrive**, reached through Microsoft Graph using an OAuth token
  brokered by the host via `ai-publish-sdk` (`getToken('onedrive')`), exactly as the sibling
  `notepad++` project does.
- The **remote side is an SFTP server**, reached over raw TCP that the host proxies through the
  SDK's `tcp` API. SSH + SFTP are implemented in-browser on top of that socket.

This is Phase 1 of a larger effort. Later phases add S3, WebDAV, FTP, multiple session tabs, and
directory synchronize/mirror. Phase 1 delivers the full application shell plus the flagship SFTP
protocol, chosen (by the project owner) as the highest-value/highest-risk piece to build first.

### Reference project

`C:\Users\ben\Documents\Claude\Projects\notepad++` — a working PWA on the same stack that stores
files in OneDrive via `ai-publish-sdk`. We reuse its patterns wholesale:

- `src/sdk/client.ts` — crash-safe wrappers around the SDK.
- `src/onedrive/{auth,session,graph}.ts` — session coordinator + Graph REST client.
- `src/platform/{profiles,usePlatform}.ts` — container-dimension classification.
- Vite + React 18 + TS + Tailwind + `vite-plugin-pwa` + Vitest toolchain.

## 2. Non-Negotiable Constraints

1. **Pure static client-side SPA.** `npm ci && npm run build` runs once in CI; the build output
   (`dist/`) is everything that ships, served as static assets behind a CDN. No server process,
   SSR runtime, edge runtime, API routes, or backend. All logic runs in the browser.
2. **No local-disk use for the local side.** Source/destination files, temp buffers — everything
   stays in OneDrive and in memory. No File System Access API, no downloads folder, no `<a download>`.
3. **All host communication goes through `ai-publish-sdk` only.** No mock data, no custom
   postMessage, no placeholder implementations in shipped paths.
4. **Multi-context rendering.** The same app renders correctly full-page, in the four widget
   profiles (344×165, 388×510, 720×510, 1100×510), and in the Chrome side panel (≥360×900), via a
   single top-level layout switch on measured container size.
5. **PWA / full screen allowed.** Not constrained to widget dimensions; uses the full viewport when
   given one.
6. **Light/dark mode.**
7. After generating `package.json`, run `npm install --package-lock-only --ignore-scripts --no-audit`
   and ship the resulting `package-lock.json`.

## 3. Architecture

### 3.1 Layer map

```
ui/  layouts/         thick-app chrome + fluid layout modes
   ↓
state/                active session, panes, transfer queue (React context)
   ↓
fs/  FileSystem       unified interface: list/stat/mkdir/rename/remove/move/openRead/openWrite
   ├── OneDriveFS     Graph client (extended from notepad++)
   └── SftpFS         SFTP subsystem
        ↓
   sftp/              SFTP v3 codec + operations
        ↓
   ssh/               SSH2 transport: framing · kex · hostkey · ciphers · userauth · channels
        ↓
   net/               buffered byte-stream over the sdk `tcp` API (base64 ↔ Uint8Array)
transfer/             chunked streaming engine between any two FileSystems + queue
connections/          saved-connection model + encrypted vault (master passphrase)
theme/                light/dark tokens + toggle
sdk/                  ai-publish-sdk wrappers (client.ts + tcp.ts)
platform/             fluid container classification
```

### 3.2 The `FileSystem` seam (extension point for future protocols)

A single interface that both sides implement now; future protocols slot in without touching the
transfer engine or UI.

```ts
interface FsEntry {
  name: string;
  path: string;            // POSIX-style path within this filesystem
  kind: 'file' | 'dir' | 'symlink';
  size?: number;
  mtime?: number;          // epoch ms
  mode?: number;           // POSIX permission bits, when known (SFTP)
  owner?: string; group?: string;
  raw?: unknown;           // adapter-specific (e.g. Graph DriveItem, SFTP attrs)
}

interface ReadHandle  { read(into: Uint8Array): Promise<number>; close(): Promise<void>; size?: number; }
interface WriteHandle { write(chunk: Uint8Array): Promise<void>;  close(): Promise<void>; }

interface FileSystem {
  readonly kind: 'onedrive' | 'sftp';
  list(path: string): Promise<FsEntry[]>;
  stat(path: string): Promise<FsEntry>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  move(from: string, to: string): Promise<void>;      // may be rename or copy+delete
  openRead(path: string): Promise<ReadHandle>;
  openWrite(path: string, size?: number): Promise<WriteHandle>;
  chmod?(path: string, mode: number): Promise<void>;  // optional; SFTP only in P1
}
```

`OneDriveFS` wraps/extends the notepad++ Graph client, adding: recursive `remove`, `mkdir` (create
folder), `rename`/`move` (PATCH `name`/`parentReference`), binary `openRead` (range GET) and
`openWrite` (resumable upload session for arbitrary bytes, not just text). `chmod` is absent
(OneDrive has no POSIX modes).

### 3.3 SSH/SFTP stack

**Crypto:** pure-JS via `@noble/curves`, `@noble/ciphers`, `@noble/hashes` — audited, tiny,
browser-native, and independent of WebCrypto algorithm availability.

**Negotiated algorithms (client preference order), covering essentially all modern OpenSSH:**

| Role       | Algorithms |
|------------|------------|
| KEX        | `curve25519-sha256`, `curve25519-sha256@libssh.org` |
| Host key   | `ssh-ed25519`, `rsa-sha2-512`, `rsa-sha2-256` |
| Cipher     | `chacha20-poly1305@openssh.com`, `aes256-gcm@openssh.com`, `aes128-gcm@openssh.com` |
| MAC        | (none for AEAD ciphers) `hmac-sha2-256` fallback |
| Compression| `none` |

**`ssh/` responsibilities:** version-exchange banner, binary packet protocol (length + padding,
per-direction sequence numbers), `KEXINIT` negotiation, curve25519 ECDH, exchange-hash + session-id,
host-key signature verification, AEAD cipher/keys derivation and rekey, `SERVICE_REQUEST`,
`USERAUTH` (`password`, `publickey` with ed25519/RSA signing, optional key passphrase), and channel
management (`CHANNEL_OPEN session`, `subsystem sftp`, window/data/EOF/close).

**Host-key trust = TOFU.** First connect surfaces the `SHA256:…` fingerprint for explicit
acceptance; accepted keys are stored in an IndexedDB known-hosts keyed by `host:port`. A changed key
produces a hard, blocking warning.

**`sftp/`:** SFTP protocol version 3 (OpenSSH's dialect). Operations: `INIT/VERSION`, `OPEN/READ/
WRITE/CLOSE`, `OPENDIR/READDIR`, `MKDIR/RMDIR`, `REMOVE`, `RENAME`, `STAT/LSTAT/FSTAT`, `SETSTAT`
(chmod/permissions), `REALPATH`. Reads/writes use pipelined windowed requests for throughput.

### 3.4 TCP transport (`net/`)

Wraps the SDK `tcp` socket (`connect(host, port)` → `{ send(b64), receive(): b64, close() }`) as a
buffered binary byte-stream: base64 encode on send; base64 decode + accumulate on receive with a
pull API `readExactly(n)` / `readLine()` that the SSH framing layer consumes. All calls go through
the `sdk/tcp.ts` crash-safe wrapper; a missing host degrades to a clear "TCP unavailable" error.

## 4. UI / UX

### 4.1 Fluid layout modes

`platform/profiles.ts` classifies the **measured** container size into a *mode* and the app scales
continuously within each (draggable splitter, flexing columns/rows) rather than snapping to canned
sizes:

- **Commander** (≈ width ≥ 640 **and** height ≥ 360): dual pane (OneDrive | remote) + docked
  transfer queue. Covers full-page, XL widget, Expanded widget, and larger.
- **Tabbed single** (smaller, down to ≈ 320×420): one pane with an OneDrive⇄remote tab toggle,
  drill-down navigation, queue at the bottom. Covers Portrait widget and the side panel.
- **Status tile** (height < ≈ 220): no browsing — glanceable Queue/Session status + "Open full
  app". Covers the Landscape widget.

The four mandated widget sizes each fall naturally into whichever mode their dimensions match; the
side panel (≥360×900) lands in Tabbed single. Widget root styling remains `border-radius: 24px;
overflow: hidden;` with the app as the card and no outer wrappers, per the widget rules.

### 4.2 Thick-application feel

- Menu bar + toolbar + status bar.
- Dense, sortable columns: Name / Size / Modified / Permissions / Owner.
- Right-click context menus.
- Drag-and-drop **and** keyboard-driven transfers.
- Shift/Ctrl multi-select.
- WinSCP/Norton Commander keymap: F5 copy/transfer, F2 rename, F7 new folder, Del delete, F6 move,
  Enter open, Backspace up, Ctrl+R refresh, etc.
- Compact spacing, keyboard-first.

### 4.3 Dialogs

Connect / Login, Host-key trust prompt, Master-passphrase unlock, Transfer conflict
(overwrite/skip/rename), File properties (incl. permissions/chmod), Progress, Connection Manager.

### 4.4 Theme

Light/dark via CSS-variable token set + a toggle; choice persisted in localStorage. Honors host
branding (`getBrandingAssets`) for accent where available, like notepad++.

## 5. Connections & Security

- **Saved connection:** `{ id, name, protocol:'sftp', host, port, username, authMethod:'password'|
  'key', options, alwaysPrompt }`. Metadata stored in IndexedDB.
- **Encrypted vault for secrets:** master passphrase → PBKDF2(SHA-256, ≥210k iters, per-vault salt)
  → AES-GCM key. Secrets (password / private key text) encrypted at rest in IndexedDB; decrypted in
  memory after a once-per-session unlock. Per-connection `alwaysPrompt` stores no secret and asks at
  connect time.
- **Connection Manager UI:** list, add / edit / duplicate / delete, connect. Master-passphrase set
  on first secret save; unlock prompt on first secret use per session.
- Nothing is written to local disk; all persistence is IndexedDB/localStorage within the origin.

## 6. Transfer Engine

- A queue of jobs, each streaming **chunk-by-chunk** between two `FileSystem`s via `openRead` →
  `openWrite` (never buffering a whole file in memory).
- OneDrive side: range-download for reads; resumable upload session for writes (chunk size a
  multiple of 320 KiB per Graph rules). SFTP side: pipelined windowed read/write requests.
- Per-job progress (bytes/total, rate), cancel, small bounded concurrency (default sequential with
  a couple of parallel jobs), retry with backoff, and conflict resolution (overwrite / skip /
  rename), applied per-job or "apply to all".
- Directional both ways; within-side copy/move supported.

## 7. Scope Boundaries (Phase 1)

**In scope:** browse/navigate both sides, up/download, rename, delete, mkdir, move/copy, view
properties, chmod (SFTP), a single active SFTP session, saved-connections manager with encrypted
vault, fluid multi-context layouts, light/dark, PWA.

**Out of scope (later phases):** S3, WebDAV, FTP/FTPS; multiple simultaneous session tabs;
directory synchronize/mirror; in-app file editing (that is notepad++'s role); an interactive
terminal/shell; SSH agent forwarding (impossible in a pure browser SPA).

## 8. Testing (Vitest, jsdom)

Pure, deterministic units where the value is highest:

- `platform/profiles` mode thresholds.
- Graph URL/path builders and OneDriveFS path logic.
- SSH binary packet framing (encode/decode, padding, sequence numbers).
- curve25519 kex + exchange-hash against known SSH test vectors.
- AEAD cipher encrypt/decrypt round-trip against vectors.
- SFTP packet codec (requests/responses, attrs).
- Vault encrypt → decrypt round-trip; wrong passphrase fails cleanly.
- Transfer-queue state machine (queued → active → done/error/cancelled, conflict handling).
- A mock TCP byte-stream to drive an SSH handshake unit test where feasible.

## 9. Build & Delivery

- Vite static SPA build; no SSR/edge/API. Output `dist/` only.
- `vite-plugin-pwa`: web manifest + service worker caching the app shell (network-first for Graph).
- `npm install --package-lock-only --ignore-scripts --no-audit` generates the committed lockfile.
- All source lives under `C:\Users\ben\Documents\Claude\Projects\winscp-web`.

## 10. Key Dependencies

- `ai-publish-sdk` — host RPC (user info, OneDrive token, `tcp`, branding, analytics).
- `react`, `react-dom`.
- `@noble/curves`, `@noble/ciphers`, `@noble/hashes` — SSH crypto.
- Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `tailwindcss`, `postcss`, `autoprefixer`,
  `vite-plugin-pwa`, `vitest`, `jsdom`, `@types/*`.
