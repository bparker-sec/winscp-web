# Skiff

A client-side, browser-based file-transfer client with a familiar two-pane
"commander" layout. The left pane is your **OneDrive**; the right pane is a
**remote server** over SFTP, FTP, or FTPS. It runs entirely in the browser as a
static PWA — there is no backend of its own; raw TCP for SSH/FTP is relayed
through the host app's TCP proxy, and OneDrive is accessed via Microsoft Graph.

> **Name:** "Skiff" is a working title. Verify trademark availability before any
> public release.
>
> **Not affiliated with WinSCP.** Skiff is an independent, from-scratch
> implementation inspired by WinSCP's workflow. "WinSCP" is a trademark of its
> respective owner and is used here only to describe the inspiration.

## Features

- **Two-pane transfers** between OneDrive and a remote server, with drag/drop,
  multi-select, F5, and a live transfer queue showing per-file **throughput and
  elapsed time**.
- **Protocols:** SFTP (SSH), FTP, and FTPS (explicit TLS). WebDAV and S3 adapters
  exist in the codebase but are not currently exposed in the connect UI.
- **From-scratch SSH/SFTP stack:** curve25519 key exchange, ed25519 host-key TOFU
  verification, AES-GCM, publickey/password auth, mid-session **rekey** (so
  multi-GB transfers survive), and **pipelined** transfers for high throughput.
- **Encrypted private keys** (opt-in): passphrase-protected OpenSSH keys are
  decrypted once and stored decrypted inside the encrypted vault.
- **Encrypted connection vault:** saved-connection secrets are encrypted at rest
  (WebCrypto PBKDF2 + AES-GCM) behind a master passphrase.
- **Directory Synchronize / Mirror**, **multi-session tabs**, a **hidden-files
  toggle**, a **properties/permissions** dialog, **file-list virtualization** for
  large directories, resumable transfers, and light/dark themes.

## No warranty, no support

Skiff is provided **"AS IS", without warranty of any kind** and **without any
commitment to support, maintenance, or updates**. Use at your own risk. See the
[LICENSE](./LICENSE) for the full terms.

It handles credentials and private keys; review the security model before using
it with sensitive systems, and prefer keys/passphrases you can rotate.

## Development

```bash
npm install
npm run dev        # start the dev server
npm run typecheck  # tsc project references, no emit
npm run lint       # eslint
npm run format     # prettier --write
npm test           # vitest
npm run build      # production PWA build
```

Live-verification harnesses for the real protocol stacks live in `scripts/`
(dev-only, run with `tsx`): `ssh-verify`, `sftp-verify`, `transfer-verify`,
`ftp-verify` (set `FTP_SECURE=1` for FTPS), and `webdav-verify`.

## License

[GNU General Public License v3.0 or later](./LICENSE).
