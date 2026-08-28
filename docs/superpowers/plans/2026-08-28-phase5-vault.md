# WinSCP Web — Plan 5: Encrypted Connection Vault & Manager

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with spec + code-quality review. Checkbox steps.

**Goal:** A saved-connections system with an encrypted vault: connection metadata is always readable; secrets (password / private key) are encrypted at rest with a master passphrase (WebCrypto PBKDF2 → AES-GCM), unlocked once per session. A Connection Manager UI lists/add/edit/duplicate/delete/connect; the Connect dialog can save a connection. Per-connection "always prompt" stores no secret.

**Depends on:** 4b (`SftpCredentials`, the remote connect flow in `AppProvider`, `ConnectDialog`). No changes to the SSH/SFTP/FileSystem layers.

**Confirmed:** `crypto.subtle` (PBKDF2 + AES-GCM) works in the vitest jsdom env — use it directly.

## Design

### Storage
Single localStorage key `winscp-connections` holding JSON:
```
{
  version: 1,
  kdf: { salt: base64, iterations: number } | null,   // null until a passphrase is set
  verifier: { iv: base64, ct: base64 } | null,         // encrypt of a known constant, to check the passphrase
  connections: SavedConnection[]
}
```
`SavedConnection = { id, name, protocol:'sftp', host, port, username, authMethod:'password'|'key', alwaysPrompt:boolean, secret?: { iv:base64, ct:base64 } }`. Metadata is plaintext; `secret` present only when a secret was saved (and `alwaysPrompt` is false). base64 via `src/net/base64.ts`.

### Crypto (`src/connections/crypto.ts`)
Thin WebCrypto wrappers:
- `deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey>` — importKey(PBKDF2) → deriveKey(AES-GCM 256, encrypt/decrypt).
- `encryptString(key, plaintext: string): Promise<{iv, ct}>` (iv = 12 random bytes; both returned as Uint8Array). `decryptToString(key, iv, ct): Promise<string>`.
- `randomSalt(): Uint8Array` (16 bytes). Default `ITERATIONS = 210_000`.

### Vault (`src/connections/vault.ts`)
Owns the master-passphrase lifecycle (a class, DI the storage for testability — accept a `Storage`-like `{getItem,setItem,removeItem}`, default localStorage):
- state: `'uninitialized'` (no passphrase set) | `'locked'` (passphrase set, not yet unlocked this session) | `'unlocked'`.
- `initialize(passphrase)`: generate salt, deriveKey, encrypt a fixed VERIFIER_CONSTANT → store kdf + verifier; hold the key in memory (state → unlocked).
- `unlock(passphrase): Promise<boolean>`: deriveKey with stored salt/iters; decrypt verifier; if it equals VERIFIER_CONSTANT → hold key, unlocked, true; else false (wrong passphrase).
- `lock()`: drop the in-memory key (state → locked). `reset()`: wipe kdf+verifier (careful — invalidates all stored secrets; only on explicit user action).
- `encryptSecret(plaintext): Promise<{iv,ct}>` and `decryptSecret({iv,ct}): Promise<string>` — require unlocked (throw if not). Store iv/ct as base64 in the model (convert at the store layer or here — keep here returning Uint8Array, store layer base64s).
- The key NEVER leaves memory; never persisted; never logged.

### Store (`src/connections/store.ts`)
`ConnectionStore` over the vault + localStorage:
- `list(): SavedConnection[]` (metadata only, always available).
- `save(conn, secret?)`: upsert by id; if secret provided and !alwaysPrompt → `vault.encryptSecret(secret)` → store base64 iv/ct; else clear secret. Requires vault unlocked when encrypting.
- `remove(id)`, `duplicate(id)` (new id, name + ' copy', drops secret).
- `getSecret(id): Promise<string|null>` — if the conn has an encrypted secret → `vault.decryptSecret` → plaintext; else null (caller must prompt).
- `needsPassphrase(): boolean` (a secret save is requested but vault uninitialized), `hasSecret(id)`.
- Pure JSON (de)serialization; guard against corrupt storage.

### UI
- `src/ui/MasterPassphraseDialog.tsx` — mode `'set'` (new passphrase + confirm) or `'unlock'` (passphrase; shows error on wrong). Calls vault initialize/unlock via the provider.
- `src/ui/ConnectionManager.tsx` — a Modal listing saved connections (name, user@host); buttons per row: Connect, Edit, Duplicate, Delete; a "New connection" button. Connect: if the conn has a secret → ensure vault unlocked (else show MasterPassphraseDialog unlock) → decrypt → `remoteConnect`; if alwaysPrompt/no secret → open the ConnectDialog prefilled. Edit → ConnectDialog prefilled with the connection.
- `ConnectDialog` (extend): add a "Save this connection" checkbox + optional name; on connect, if checked → save metadata (and secret unless alwaysPrompt); a per-form "Always prompt for password" checkbox. If saving a secret and the vault is uninitialized → prompt to set a master passphrase first (MasterPassphraseDialog 'set').
- Entry point: a "Manage connections" / "Saved…" button in the MenuBar or RemoteConnectHint that opens the ConnectionManager.

### AppProvider wiring
Add: a `ConnectionStore`/`Vault` instance (memoized), `connections: SavedConnection[]` (reactive), `connectionManagerOpen`, `passphraseDialog: {mode} | null`, and actions: `openConnectionManager/close`, `saveConnection(conn, secret?)`, `deleteConnection`, `duplicateConnection`, `connectSaved(id)` (handles unlock + decrypt + remoteConnect, or opens the ConnectDialog when a prompt is needed), `setMasterPassphrase(p)`, `unlockVault(p)`. Keep the existing 4b remote-connect flow; `connectSaved` funnels into `remoteConnect`.

## Milestones
- **M1 — crypto + vault.** `crypto.ts` (+test: derive→encrypt→decrypt round-trip; wrong-key decrypt throws; deterministic derive for same salt/pass). `vault.ts` (+test with an in-memory storage fake: initialize→unlock-with-right-pass true / wrong-pass false; lock drops key so encryptSecret throws; persistence — a new Vault over the same storage is 'locked' and unlocks; encryptSecret→decryptSecret round-trip while unlocked).
- **M2 — store.** `store.ts` (+test with in-memory storage + an unlocked vault): save metadata-only (alwaysPrompt) → getSecret null; save with secret → getSecret returns it after unlock; list/remove/duplicate; corrupt-storage → empty list, no throw; base64 round-trip of iv/ct.
- **M3 — UI + AppProvider wiring + build.** `MasterPassphraseDialog`, `ConnectionManager`, extend `ConnectDialog` (save + always-prompt), entry point, AppProvider actions. Render tests (mock the store/vault): ConnectionManager lists connections and Connect on a secret-less/alwaysPrompt row opens the ConnectDialog; MasterPassphraseDialog set-mode requires matching confirm. `npm run build` static; full suite green; typecheck clean.

## Guardrails
- The derived AES key and any decrypted secret string: never logged, never persisted, dropped on `lock()`/disconnect. Passphrase never stored.
- `alwaysPrompt` connections store ZERO secret bytes.
- Resetting the vault (forgotten passphrase) must warn that it invalidates all saved secrets.
- Corrupt/absent storage degrades to an empty connection list, never throws into the UI.
- This is client-side at-rest encryption in the browser origin — document that it protects against casual local inspection, not a determined attacker with the unlocked session; it's equivalent to WinSCP's master-password feature.
