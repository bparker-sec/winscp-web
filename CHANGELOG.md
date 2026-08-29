# Changelog

All notable changes to this project are documented here. Versions follow
semantic-ish versioning during the pre-1.0 build-out.

## [Unreleased]

- Accessibility pass (ARIA roles, focus management, screen-reader labels).
- CI (GitHub Actions), ESLint + Prettier, GPLv3 license, browser end-to-end
  smoke test — targeting a 1.0 release.

## [0.7.0]

- **FTPS (explicit FTP over TLS)** via a node-forge TLS layer over the raw-socket
  transport. Live-verified against a real TLS server. (forge is limited to TLS
  1.0–1.2 with RSA-key-exchange AES-CBC ciphers; no TLS 1.3/ECDHE/session reuse.)
- **Passphrase-protected SSH keys** (opt-in setting): decrypt once, store
  decrypted in the vault. Pure-TS `bcrypt_pbkdf` + Blowfish; aes-ctr/cbc/gcm.
- **PaneView UX:** dependency-free row virtualization, hidden-files toggle, and a
  properties/permissions (chmod) dialog.
- **Transfer-queue persistence:** completed/failed history survives reload
  (display-only; in-flight transfers can't resume across a reload).

## [0.6.0]

- Renamed from "WinSCP Web" to **Skiff** (working title) to remove trademark
  exposure; **GPLv3** license; dark-mode dropdown fix; WebDAV/S3 removed from the
  connect UI (adapters retained).

## [0.5.0] – [0.5.1]

- **Multi-session tabs** for remote connections (parked/active sessions,
  per-session reconnect). Two concurrent SFTP sessions live-verified.
- **WebDAV and FTP adapters live-verified** against real servers (wsgidav,
  pyftpdlib). S3 remains unit-verified against the official AWS SigV4 vector.

## [0.4.0]

- **WebDAV, FTP, and S3 `FileSystem` adapters** + a protocol picker (later
  narrowed to SFTP/FTP in the GUI). `connectRemote` dispatcher.

## [0.3.0]

- **Directory Synchronize / Mirror** (Update and Mirror modes) with a preview
  dialog. Live-verified.

## [0.2.0] – [0.2.1]

- **Large-file SFTP fix** (message-size cap), **SSH rekey** for multi-GB
  transfers, **pipelined transfers** with tunable depth/window settings, and a
  live **throughput + elapsed time** display in the transfer queue.

## 0.1.0

- Initial functional core: OneDrive ⇄ SFTP transfers, encrypted connection vault,
  transfer engine, from-scratch SSH/SFTP stack. (See git history for phases 1–6.)
