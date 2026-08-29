import { useState } from 'react';
import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';
import {
  parseOpenSshPrivateKey,
  isEncryptedOpenSshKey,
  encodeUnencryptedOpenSshKey,
  EncryptedKeyError,
} from '../ssh/privatekey';
import { ConnectionStore } from '../connections/store';
import type { SftpCredentials } from '../sftp/SftpConnection';
import type { RemoteCredentials, RemoteProtocol } from '../remote/connect';

type AuthMethod = 'password' | 'key';

// GUI currently exposes SFTP + FTP. The WebDAV/S3 adapters exist and are tested,
// but are not surfaced here yet (fetch-based; CORS/mixed-content constraints).
const PROTOCOLS: { value: RemoteProtocol; label: string; defaultPort: number }[] = [
  { value: 'sftp', label: 'SFTP (SSH)', defaultPort: 22 },
  { value: 'ftp', label: 'FTP', defaultPort: 21 },
];

export function ConnectDialog() {
  const {
    remoteConnecting,
    remoteError,
    remoteConnect,
    closeConnectDialog,
    connectDialogPrefill,
    saveConnection,
    enablePassphraseKeys,
  } = useApp();

  const prefill = connectDialogPrefill;
  const [protocol, setProtocol] = useState<RemoteProtocol>('sftp');

  const [host, setHost] = useState(prefill?.host ?? '');
  const [port, setPort] = useState(prefill?.port ?? 22);
  const [username, setUsername] = useState(prefill?.username ?? '');
  const [authMethod, setAuthMethod] = useState<AuthMethod>(prefill?.authMethod ?? 'password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');

  const [localError, setLocalError] = useState<string | null>(null);
  const [saveEnabled, setSaveEnabled] = useState(!!prefill);
  const [connectionName, setConnectionName] = useState(prefill?.name ?? '');
  const [alwaysPrompt, setAlwaysPrompt] = useState(prefill?.alwaysPrompt ?? false);

  const canSave = protocol === 'sftp'; // saved connections are SFTP-only for now

  const changeProtocol = (p: RemoteProtocol) => {
    setProtocol(p);
    setLocalError(null);
    const def = PROTOCOLS.find((x) => x.value === p)?.defaultPort ?? 22;
    setPort(def);
    if (p !== 'sftp') setSaveEnabled(false);
  };

  // Returns the credentials plus the secret string to persist if saving (for a
  // key that's passphrase-encrypted, that's the decrypted form so no passphrase
  // is needed again). Sets localError and returns null on a bad key/passphrase.
  const buildCreds = (): { creds: RemoteCredentials; saveSecret: string } | null => {
    if (protocol === 'sftp') {
      const creds: SftpCredentials = { host, port, username };
      if (authMethod === 'key') {
        const encrypted = isEncryptedOpenSshKey(privateKey);
        if (encrypted && !enablePassphraseKeys) {
          setLocalError(
            'This key is passphrase-protected. Turn on “Enable passphrase-protected SSH keys” in Settings to use it.',
          );
          return null;
        }
        let parsed;
        try {
          parsed = parseOpenSshPrivateKey(privateKey, keyPassphrase || undefined);
        } catch (err) {
          if (err instanceof EncryptedKeyError) {
            setLocalError('This key is encrypted — enter its passphrase.');
          } else {
            setLocalError(err instanceof Error ? err.message : 'Unsupported or invalid private key.');
          }
          return null;
        }
        creds.privateKey = { seed: parsed.seed, publicKey: parsed.publicKey };
        // Save the decrypted key (as an unencrypted PEM) so reconnecting never
        // needs the passphrase; an already-plain key is stored as-is.
        const saveSecret = encrypted
          ? encodeUnencryptedOpenSshKey(parsed.seed, parsed.publicKey)
          : privateKey;
        return { creds: { protocol: 'sftp', ...creds }, saveSecret };
      }
      creds.password = password;
      return { creds: { protocol: 'sftp', ...creds }, saveSecret: password };
    }
    // ftp (not saveable yet)
    return { creds: { protocol: 'ftp', host, port, username, password }, saveSecret: '' };
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const built = buildCreds();
    if (!built) return;
    const { creds, saveSecret } = built;

    if (canSave && saveEnabled) {
      const id = prefill?.id ?? ConnectionStore.newId();
      const secretToSave = alwaysPrompt || !saveSecret ? undefined : saveSecret;
      void saveConnection(
        {
          id,
          name: connectionName || `${username}@${host}`,
          protocol: 'sftp',
          host,
          port,
          username,
          authMethod,
          alwaysPrompt,
        },
        secretToSave,
      );
    }

    remoteConnect(creds);
  };

  const field = 'h-8 px-2 rounded border border-border bg-transparent';

  return (
    <Modal title="Connect to server" onClose={closeConnectDialog}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px]">
          Protocol
          <select
            className={field}
            value={protocol}
            onChange={(e) => changeProtocol(e.target.value as RemoteProtocol)}
          >
            {PROTOCOLS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[13px]">
          Host
          <input className={field} value={host} onChange={(e) => setHost(e.target.value)} required />
        </label>
        <label className="flex flex-col gap-1 text-[13px]">
          Port
          <input
            type="number"
            className={field}
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 22)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-[13px]">
          Username
          <input className={field} value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>

        {protocol === 'sftp' && (
          <fieldset className="flex flex-col gap-1 text-[13px]">
            <legend className="mb-1">Authentication</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="authMethod"
                  checked={authMethod === 'password'}
                  onChange={() => setAuthMethod('password')}
                />
                Password
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="authMethod"
                  checked={authMethod === 'key'}
                  onChange={() => setAuthMethod('key')}
                />
                Private key
              </label>
            </div>
          </fieldset>
        )}

        {(protocol === 'ftp' || (protocol === 'sftp' && authMethod === 'password')) && (
          <label className="flex flex-col gap-1 text-[13px]">
            Password
            <input
              type="password"
              className={field}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}

        {protocol === 'sftp' && authMethod === 'key' && (
          <>
            <label className="flex flex-col gap-1 text-[13px]">
              Private key (OpenSSH PEM)
              <textarea
                className="h-24 px-2 py-1 rounded border border-border bg-transparent font-mono text-[12px]"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              />
              <span className="text-muted text-[11px]">
                {enablePassphraseKeys
                  ? 'Passphrase-protected keys are supported (enter the passphrase below).'
                  : 'Passphrase-protected keys are off — enable them in Settings to use one.'}
              </span>
            </label>
            {enablePassphraseKeys && (
              <label className="flex flex-col gap-1 text-[13px]">
                Key passphrase (only if the key is encrypted)
                <input
                  type="password"
                  className={field}
                  value={keyPassphrase}
                  onChange={(e) => setKeyPassphrase(e.target.value)}
                  autoComplete="off"
                />
              </label>
            )}
          </>
        )}

        {canSave && (
          <>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={saveEnabled} onChange={(e) => setSaveEnabled(e.target.checked)} />
              Save this connection
            </label>

            {saveEnabled && (
              <label className="flex flex-col gap-1 text-[13px]">
                Name
                <input
                  className={field}
                  value={connectionName}
                  onChange={(e) => setConnectionName(e.target.value)}
                  placeholder={username && host ? `${username}@${host}` : 'My connection'}
                />
              </label>
            )}

            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={alwaysPrompt} onChange={(e) => setAlwaysPrompt(e.target.checked)} />
              Always prompt for password (don&apos;t store secret)
            </label>
          </>
        )}

        {localError && (
          <div role="alert" className="text-danger text-[12px]">
            {localError}
          </div>
        )}
        {remoteError && (
          <div role="alert" className="text-danger text-[12px]">
            {remoteError}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <button type="button" className="h-8 px-3 rounded border border-border" onClick={closeConnectDialog}>
            Cancel
          </button>
          <button
            type="submit"
            className="h-8 px-4 rounded bg-accent text-accent-fg disabled:opacity-60"
            disabled={remoteConnecting}
          >
            {remoteConnecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
