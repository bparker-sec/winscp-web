# WinSCP Web — Plan 4b: Connect UI & Live Remote Pane

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with spec + code-quality review. Checkbox steps.

**Goal:** Make the remote pane connectable in the app: a Connect dialog (host/port/user/password-or-key), a host-key TOFU prompt wired to the SSH trust callback, remote connect/disconnect state in `AppProvider`, and pointing the remote pane at the live `SftpFS` starting at its `home` — with a UI-level connect timeout. Verified by typecheck/build + component render tests (the SDK `tcp` proxy only exists inside the host, so no live network in dev; the protocol is already live-proven in 4a).

**Depends on:** 4a (`connectSftp` → `{fs, fingerprint, home, close}`, `SftpCredentials`), `src/ssh/privatekey.ts` (`parseOpenSshPrivateKey`), `src/ssh/SshClient.ts` (the trust-callback type), `src/ssh/knownhosts.ts` (`rememberHost`). The `FileSystem` interface is unchanged — the remote pane consumes `SftpFS` exactly like OneDriveFS.

## Design

### AppProvider — add remote-connection state
Replace the `remote = MockFS` with real state:
- `remote: FileSystem | null` (null until connected), `remoteHome: string` ('/' default), `remoteLabel?: string`, `remoteConnecting: boolean`, `remoteError: string | null`.
- `connectDialogOpen: boolean`, `openConnectDialog()`, `closeConnectDialog()`.
- `remoteConnect(creds: SftpCredentials): void` — sets connecting; races `connectSftp(creds, trust, label)` against a 30s timeout; on success stores the connection + sets `remote`/`remoteHome` + closes the dialog; on failure sets `remoteError` and clears any pending host-key prompt.
- `remoteDisconnect(): void` — `conn.close()`, clear `remote`/`remoteHome`.
- **Host-key TOFU prompt:** `hostKeyPrompt: { host: string; fingerprint: string; status: 'new'|'mismatch'|'match' } | null` and `resolveHostKey(accept: boolean): void`. The `trust` callback passed to `connectSftp` returns a Promise resolved by `resolveHostKey`: on accept, `rememberHost(host, port, fingerprint)` and resolve(true); on reject resolve(false) (→ SshClient throws, connect fails). A `match` status auto-accepts without prompting. Use a `useRef` to hold the resolver.

### Components
- `src/ui/ConnectDialog.tsx` — a modal form: host, port (default 22), username, auth method (Password | Private key), a password field OR a private-key textarea (paste OpenSSH PEM) + optional key-passphrase note ("encrypted keys not yet supported"). On submit, if key method: `parseOpenSshPrivateKey(pem)` (catch → show inline error "Unsupported or invalid key"); build `SftpCredentials` and call `remoteConnect`. Cancel closes. Show `remoteConnecting`/`remoteError`.
- `src/ui/HostKeyPrompt.tsx` — a modal shown when `hostKeyPrompt` is set: displays host + `SHA256:` fingerprint + a warning for `mismatch` (red) vs `new` (neutral); Accept/Reject buttons calling `resolveHostKey`.
- `src/ui/RemoteConnectHint.tsx` — the remote pane's not-connected state: a "Connect to a server" button that calls `openConnectDialog`, plus `remoteError` if present.

### Modal shell
Add a minimal `src/ui/Modal.tsx` (fixed overlay + centered card, `bg-black/40` backdrop, `bg-surface` card, Esc/backdrop-click to close via an `onClose`) reused by ConnectDialog + HostKeyPrompt. Keep it dependency-free.

### PaneView — initial path
Add an optional `initialPath?: string` prop (default `'/'`); use it as the initial `cwd` so the remote pane opens at `home`.

### Layout wiring
- `Commander.tsx` / `TabbedSingle.tsx`: remote pane renders `<PaneView fs={remote} header={remote.label} initialPath={remoteHome} />` when connected, else `<RemoteConnectHint ... />`. Render `<ConnectDialog>` when `connectDialogOpen` and `<HostKeyPrompt>` when `hostKeyPrompt` (mount them once at the layout root so they overlay).
- `StatusTile.tsx`: unchanged (or show remote connected/label — optional, keep minimal).

## Milestones
- **M1 — AppProvider remote state + Modal + the three dialog/hint components.** Full remote-connection logic (timeout via `Promise.race`, trust-callback→prompt→resolver, disconnect), `Modal`, `ConnectDialog`, `HostKeyPrompt`, `RemoteConnectHint`. Component render tests (@testing-library/react): ConnectDialog shows fields and calls `remoteConnect` with parsed creds on submit (mock `useApp`); HostKeyPrompt shows the fingerprint and Accept calls `resolveHostKey(true)`; RemoteConnectHint's button calls `openConnectDialog`. A key-parse-failure path shows the inline error. (Mock `connectSftp`/`parseOpenSshPrivateKey` where needed.)
- **M2 — PaneView initialPath + layout wiring + build.** Add `initialPath`; wire Commander/TabbedSingle to render the remote pane / RemoteConnectHint / dialogs; `npm run build` (exit 0 static), `npm test` green, typecheck clean. A render test that a layout shows RemoteConnectHint when `remote` is null and PaneView when set (mock the provider).

## Notes / guardrails
- **Connect timeout is REQUIRED** (30s `Promise.race`) — the SSH/SFTP stack has none; without it a stalled server hangs forever.
- Credentials entered by the USER into the form are used transiently for the connect; **no persistence in 4b** (the encrypted vault is Phase 5). Do not log the password/key.
- Encrypted private keys / RSA keys are not supported yet — surface a clear inline message, don't crash.
- Outside the host (dev/build/review), `tcpConnect` returns `{ok:false}` so `connectSftp` throws a clear error → `remoteError` shows it; the app must not crash.
- Theme-aware, works across Commander/Tabbed layouts; modals use the `--danger` token for warnings/errors.
