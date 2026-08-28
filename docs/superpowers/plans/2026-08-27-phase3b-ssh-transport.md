# WinSCP Web — Plan 3b: SSH Transport, Userauth & Channels

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with a spec reviewer + code-quality reviewer per major step. Steps use checkbox (`- [ ]`).

**Goal:** Build the SSH2 transport on the Plan 3a foundations: identification-string exchange, `KEXINIT` negotiation, curve25519 key exchange with exchange-hash assembly and Ed25519 host-key verification (TOFU), the encrypted binary-packet layer (AES-GCM), userauth (password + Ed25519 publickey, incl. unencrypted OpenSSH key parsing), and channels (open the `sftp` subsystem). The deliverable is an `SshClient` that, given a `ByteStream` + config, connects, authenticates, and returns a bidirectional byte channel for Plan 4's SFTP layer. **Final gate: a Node harness runs the real handshake against a live SSH server.**

**Depends on:** Plan 3a (`net/ByteStream`, `ssh/wire`, `ssh/crypto/{x25519,ed25519,aesgcm,kdf}`). No changes to those.

> **Status:** ✅ Implemented and **live-verified against a real OpenSSH server** via
> `scripts/ssh-verify.mts` — curve25519 kex + ed25519 host-key verify + ed25519
> publickey auth + `sftp` subsystem + SFTP `INIT`/`VERSION` (server SFTP v3) all
> pass end-to-end. The live run also caught a bug the unit tests missed: a server
> that opens a channel with `window = 0` and grants the real window via an early
> `CHANNEL_WINDOW_ADJUST` (arriving before `CHANNEL_SUCCESS`) — `recvExpecting`
> was dropping it and deadlocking the first write. Fixed by routing channel
> messages through a shared `dispatchChannelMessage` from both `recvExpecting`
> and `readLoop`.

**Scope note (deliberate):** algorithms = `curve25519-sha256` kex, `ssh-ed25519` host key, `aes256-gcm@openssh.com` (+`aes128-gcm@openssh.com`) cipher, password + `ssh-ed25519` publickey auth (unencrypted OpenSSH keys). **Deferred to later plans:** RSA host keys / rsa-sha2 user keys, chacha20-poly1305, passphrase-encrypted private keys (bcrypt-pbkdf), rekeying, keyboard-interactive. These are additive and don't change the interfaces built here.

---

## Protocol reference (implement exactly — these are the error-prone parts)

### Identification (RFC 4253 §4.2)
- Client sends `SSH-2.0-WinSCPWeb_0.1\r\n`.
- Server sends lines; ignore any line not starting with `SSH-`; the `SSH-...` line (CR/LF stripped) is `V_S`. `V_C` is our sent string **without** CRLF. Keep both for the exchange hash.

### Binary Packet Protocol
- Cleartext (cipher "none", used through KEX until NEWKEYS): `uint32 packet_length` (= 1 + payload + padding), `byte padding_length`, `payload`, `random padding`. Total `(4 + packet_length)` must be a multiple of 8 (block size for "none"); `padding_length` ≥ 4. No MAC.
- AES-GCM (`aes*-gcm@openssh.com`, after NEWKEYS): `uint32 packet_length` sent **in clear** and used as GCM **AAD**; the encrypted portion is `byte padding_length || payload || padding` where `(1 + payload + padding)` is a multiple of 16 and `padding_length` ≥ 4; the 16-byte GCM tag follows. So on the wire: `packet_length(4) || ciphertext || tag(16)`, where `packet_length = 1 + payload_len + padding_len`. The 12-byte IV is `fixed(4)||counter(8)` from the KDF; increment the counter after every packet (`incrementGcmIv`).
- Per-direction packet sequence numbers start at 0 and increment per packet (uint32 wrap). Not needed in the GCM AAD, but track them (used elsewhere / future MACs).

### KEXINIT (RFC 4253 §7.1) payload
`byte SSH_MSG_KEXINIT(20) || byte[16] cookie(random) || name-list kex_algorithms || name-list server_host_key_algorithms || name-list encryption_c2s || name-list encryption_s2c || name-list mac_c2s || name-list mac_s2c || name-list compression_c2s || name-list compression_s2c || name-list languages_c2s || name-list languages_s2c || boolean first_kex_packet_follows(false) || uint32 reserved(0)`.
Client lists: kex `curve25519-sha256,curve25519-sha256@libssh.org`; host key `ssh-ed25519`; enc `aes256-gcm@openssh.com,aes128-gcm@openssh.com`; mac `` (empty — AEAD supplies its own; but include `hmac-sha2-256` as a harmless fallback is optional — keep empty is fine since gcm is AEAD); compression `none`; languages empty.
Negotiation: for each category, the chosen algo is the **first client-listed name that also appears in the server's list**. If none, fail.
`I_C` / `I_S` for the exchange hash are the **entire KEXINIT payloads** (from the message byte through reserved), as received/sent.

### curve25519 kex
- Client: generate X25519 pair; send `byte SSH_MSG_KEX_ECDH_INIT(30) || string Q_C(32)`.
- Server: `byte SSH_MSG_KEX_ECDH_REPLY(31) || string K_S(host key blob) || string Q_S(32) || string signature`.
- Shared `K = x25519SharedSecret(clientSecret, Q_S)` (32 bytes, big-endian magnitude).
- Exchange hash `H = sha256( string(V_C) || string(V_S) || string(I_C) || string(I_S) || string(K_S) || string(Q_C) || string(Q_S) || mpint(K) )`. Use `SshWriter`: `.string(V_C).string(V_S).string(I_C).string(I_S).string(K_S).string(Q_C).string(Q_S).mpint(K)` then `sha256(finish())`. **`mpint(K)` normalizes K** (Plan 3a). `session_id = H` (first kex).
- Verify: parse `K_S` = `string "ssh-ed25519" || string hostPub(32)`; parse `signature` = `string "ssh-ed25519" || string sig(64)`; `ed25519Verify(sig, H, hostPub)` must be true.

### Host-key TOFU
- Fingerprint = `SHA256(K_S)` base64 (no padding), displayed as `SHA256:<b64>`.
- Known-hosts: `localStorage['winscp-knownhosts']` = JSON `{ "host:port": "SHA256:<b64>" }`. First connect → caller decides trust (Plan 3b returns the fingerprint + a `trust()` continuation; the store read/write helpers live here, the UI prompt is Plan 4). A changed key → hard error.

### Key derivation (after kex, before NEWKEYS)
- Send/expect `byte SSH_MSG_NEWKEYS(21)`. After both sides send NEWKEYS, switch to the negotiated cipher.
- IV c2s = `deriveKey(mpint(K), H, 'A', session_id, 12)`, IV s2c = `'B'`, EncKey c2s = `'C'` (32 for aes256), EncKey s2c = `'D'`. (MAC keys E/F unused for GCM.) **KDF's K input is `mpint(K)`** — the same normalized, length-prefixed encoding used in H.

### Service + userauth (RFC 4252)
- `byte SSH_MSG_SERVICE_REQUEST(5) || string "ssh-userauth"`; expect `SSH_MSG_SERVICE_ACCEPT(6)`.
- Password: `byte SSH_MSG_USERAUTH_REQUEST(50) || string user || string "ssh-connection" || string "password" || boolean FALSE || string password`.
- Publickey (with signature): first build the pubkey blob `pk = string "ssh-ed25519" || string userPub(32)`. The signed data is:
  `string(session_id) || byte(SSH_MSG_USERAUTH_REQUEST) || string(user) || string("ssh-connection") || string("publickey") || boolean(TRUE) || string("ssh-ed25519") || string(pk)`.
  Sign that blob with the user's Ed25519 private key → `rawSig(64)`; wrap `sig = string "ssh-ed25519" || string rawSig`. Send:
  `byte SSH_MSG_USERAUTH_REQUEST || string user || string "ssh-connection" || string "publickey" || boolean TRUE || string "ssh-ed25519" || string pk || string sig`.
- Success `SSH_MSG_USERAUTH_SUCCESS(52)`; failure `SSH_MSG_USERAUTH_FAILURE(51)` (name-list of methods that can continue + partial-success bool).

### Channels (RFC 4254)
- `byte SSH_MSG_CHANNEL_OPEN(90) || string "session" || uint32 senderChannel(0) || uint32 initialWindow(2MB) || uint32 maxPacket(32768)`.
- Expect `SSH_MSG_CHANNEL_OPEN_CONFIRMATION(91) || uint32 recipient || uint32 sender(server) || uint32 window || uint32 maxPacket`.
- `byte SSH_MSG_CHANNEL_REQUEST(98) || uint32 recipientChannel || string "subsystem" || boolean want_reply(TRUE) || string "sftp"`; expect `SSH_MSG_CHANNEL_SUCCESS(99)` / `CHANNEL_FAILURE(100)`.
- Data: `SSH_MSG_CHANNEL_DATA(94) || uint32 recipient || string data`. Respect the peer window; send `SSH_MSG_CHANNEL_WINDOW_ADJUST(93)` as we consume incoming data. `SSH_MSG_CHANNEL_EOF(96)`, `SSH_MSG_CHANNEL_CLOSE(97)`.
- Also handle `SSH_MSG_GLOBAL_REQUEST(80)` (reply failure if want_reply), `SSH_MSG_IGNORE(2)`, `SSH_MSG_DEBUG(4)`, `SSH_MSG_DISCONNECT(1)` (throw with reason).

---

## File Structure
- `src/ssh/constants.ts` — message numbers + disconnect codes
- `src/ssh/identification.ts` (+ test) — banner exchange
- `src/ssh/packet.ts` (+ test) — BPP with pluggable none/gcm cipher + seq numbers
- `src/ssh/kex.ts` (+ test) — KEXINIT build/parse/negotiate, ECDH, exchange hash, key derivation
- `src/ssh/knownhosts.ts` (+ test) — TOFU store + fingerprint
- `src/ssh/privatekey.ts` (+ test) — parse unencrypted OpenSSH ed25519 private key
- `src/ssh/userauth.ts` (+ test) — service request + password + publickey signature blob
- `src/ssh/channel.ts` (+ test) — channel open + subsystem + duplex data/window
- `src/ssh/SshClient.ts` — orchestration facade
- `scripts/ssh-verify.mjs` — Node integration harness (NOT bundled; run manually against a live server)

---

## Milestones (each = implementer + spec review + code-quality review)

- **M1 — constants + identification + packet layer.** `constants.ts`, `identification.ts` (+test: parse a multi-line banner, skip non-`SSH-` lines), `packet.ts` (+test: none-cipher round-trip with correct padding; gcm round-trip encode→decode with a fixed key/IV recovering the payload; padding invariants; seq increment). Packet layer takes a `Cipher` strategy: `{ encode(seq, payload): Uint8Array; decodeLength(first4): number; decodePayload(seq, body): Uint8Array }` or simpler explicit none/gcm modes — design for clean swap at NEWKEYS.

- **M2 — kex.** `kex.ts`: build our KEXINIT payload; parse the server's; negotiate; build KEX_ECDH_INIT; parse KEX_ECDH_REPLY; compute K; assemble H (exact formula above) — **test H assembly against a hand-fixture** (feed known V_C/V_S/I_C/I_S/K_S/Q_C/Q_S/K, compute H with SshWriter, assert it equals `sha256` of the same bytes assembled independently in the test); derive the four keys/IVs via `deriveKey`. Negotiation tests: pick first mutual algo; throw when disjoint. Ed25519 host-key sig verify path tested with a locally-generated ed25519 key signing an arbitrary H.

- **M3 — knownhosts + privatekey.** `knownhosts.ts` (+test: first-seen stores; match passes; mismatch throws; base64 SHA256 fingerprint format). `privatekey.ts` (+test: parse an unencrypted `openssh-key-v1` ed25519 key generated by `ssh-keygen` — fixture the base64 body in the test; assert the 32-byte seed + public key extracted; reject encrypted keys with a clear error). Format: `openssh-key-v1\0` || string ciphername("none") || string kdfname("none") || string kdfopts("") || uint32 nkeys(1) || string publickey || string privatekeys-blob; the private blob (unencrypted) = `uint32 checkint x2 || string keytype || <ed25519: string pub(32) || string priv(64) = seed(32)+pub(32)> || string comment || padding`.

- **M4 — userauth + channel.** `userauth.ts` (+test: assert the exact signed-blob byte layout for publickey; password request bytes; parse SUCCESS/FAILURE). `channel.ts` (+test: build channel-open/subsystem-request bytes; window accounting; assemble a duplex over an injected packet send/recv; handle WINDOW_ADJUST).

- **M5 — SshClient orchestration.** `SshClient.ts`: `connect(stream, {host,port})` → banner+kex+newkeys → returns a handle exposing `verifyHostKey()`/fingerprint, `authenticate({username, password? , privateKey?})`, `openSubsystem('sftp') → SshChannel` (duplex byte interface `{ write(bytes), read(): Promise<Uint8Array>, close() }`). A background read-loop dispatches incoming packets to the active channel / auth / kex waiters. Unit-test the dispatch with a scripted fake packet layer where feasible.

- **M6 — live verification harness + build.** `scripts/ssh-verify.mjs`: a Node `net.Socket` wrapped as a `RawSocket` (base64 send/receive), construct `SshClient`, run against the live server from env (`SSH_HOST`, `SSH_PORT`, `SSH_USER`, key path), verify: kex succeeds, host key TOFU-stored, **publickey auth succeeds**, `sftp` subsystem opens, and (smoke) the first SFTP `SSH_FXP_INIT/VERSION` exchange returns a version (proves the channel carries data both ways). Then `npm run build` (exit 0, static — the harness under `scripts/` and `net` import must NOT be pulled into the app bundle; keep the harness out of `src/` and out of vitest's `include`). Report the live transcript.

---

## Testing strategy
- Pure/framing units for every module (Milestones 1–4) — no network.
- `SshClient` dispatch tested with scripted fakes (M5).
- **Real-server end-to-end** via the Node harness (M6) — the authoritative correctness gate for kex/cipher/auth/channel, since these can't be fully proven by vectors alone.
- The harness is a dev tool: it lives in `scripts/`, imports Node `net`, and is excluded from the browser build and the vitest suite.

## Self-review checklist (run after writing the plan's code)
- Exchange-hash byte order matches the formula exactly (a single misordered string → handshake fails).
- `mpint(K)` used in BOTH H and the KDF (not raw K).
- GCM `packet_length` is the AAD and is NOT encrypted; tag is 16 bytes; IV counter increments per packet, per direction.
- Publickey signed-blob layout matches RFC 4252 §7 exactly (session_id first, as a string).
- Channel window respected; WINDOW_ADJUST sent as incoming data is consumed.
- Harness excluded from `dist/` and vitest.
