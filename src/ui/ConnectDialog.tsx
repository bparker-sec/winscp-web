import { useState } from 'react';
import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';
import { parseOpenSshPrivateKey } from '../ssh/privatekey';
import { ConnectionStore } from '../connections/store';
import type { SftpCredentials } from '../sftp/SftpConnection';

type AuthMethod = 'password' | 'key';

export function ConnectDialog() {
  const { remoteConnecting, remoteError, remoteConnect, closeConnectDialog, connectDialogPrefill, saveConnection } =
    useApp();

  const prefill = connectDialogPrefill;
  const [host, setHost] = useState(prefill?.host ?? '');
  const [port, setPort] = useState(prefill?.port ?? 22);
  const [username, setUsername] = useState(prefill?.username ?? '');
  const [authMethod, setAuthMethod] = useState<AuthMethod>(prefill?.authMethod ?? 'password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [saveEnabled, setSaveEnabled] = useState(!!prefill);
  const [connectionName, setConnectionName] = useState(prefill?.name ?? '');
  const [alwaysPrompt, setAlwaysPrompt] = useState(prefill?.alwaysPrompt ?? false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const creds: SftpCredentials = { host, port, username };
    let secretString: string | undefined;

    if (authMethod === 'key') {
      try {
        const k = parseOpenSshPrivateKey(privateKey);
        creds.privateKey = { seed: k.seed, publicKey: k.publicKey };
        secretString = privateKey;
      } catch {
        setLocalError('Unsupported or invalid private key (encrypted keys are not yet supported).');
        return;
      }
    } else {
      creds.password = password;
      secretString = password;
    }

    if (saveEnabled) {
      void saveConnection(
        {
          id: ConnectionStore.newId(),
          name: connectionName || `${username}@${host}`,
          protocol: 'sftp',
          host,
          port,
          username,
          authMethod,
          alwaysPrompt,
        },
        alwaysPrompt ? undefined : secretString,
      );
    }

    remoteConnect(creds);
  };

  return (
    <Modal title="Connect to server" onClose={closeConnectDialog}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px]">
          Host
          <input
            className="h-8 px-2 rounded border border-border bg-transparent"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            required
          />
        </label>

        <label className="flex flex-col gap-1 text-[13px]">
          Port
          <input
            type="number"
            className="h-8 px-2 rounded border border-border bg-transparent"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 22)}
            required
          />
        </label>

        <label className="flex flex-col gap-1 text-[13px]">
          Username
          <input
            className="h-8 px-2 rounded border border-border bg-transparent"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>

        <fieldset className="flex flex-col gap-1 text-[13px]">
          <legend className="mb-1">Authentication</legend>
          <div className="flex gap-4">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="authMethod"
                value="password"
                checked={authMethod === 'password'}
                onChange={() => setAuthMethod('password')}
              />
              Password
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="authMethod"
                value="key"
                checked={authMethod === 'key'}
                onChange={() => setAuthMethod('key')}
              />
              Private key
            </label>
          </div>
        </fieldset>

        {authMethod === 'password' ? (
          <label className="flex flex-col gap-1 text-[13px]">
            Password
            <input
              type="password"
              className="h-8 px-2 rounded border border-border bg-transparent"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-[13px]">
            Private key (OpenSSH PEM)
            <textarea
              className="h-24 px-2 py-1 rounded border border-border bg-transparent font-mono text-[12px]"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
            <span className="text-muted text-[11px]">Encrypted keys are not yet supported.</span>
          </label>
        )}

        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={saveEnabled}
            onChange={(e) => setSaveEnabled(e.target.checked)}
          />
          Save this connection
        </label>

        {saveEnabled && (
          <label className="flex flex-col gap-1 text-[13px]">
            Name
            <input
              className="h-8 px-2 rounded border border-border bg-transparent"
              value={connectionName}
              onChange={(e) => setConnectionName(e.target.value)}
              placeholder={username && host ? `${username}@${host}` : 'My connection'}
            />
          </label>
        )}

        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={alwaysPrompt}
            onChange={(e) => setAlwaysPrompt(e.target.checked)}
          />
          Always prompt for password (don&apos;t store secret)
        </label>

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
          <button
            type="button"
            className="h-8 px-3 rounded border border-border"
            onClick={closeConnectDialog}
          >
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
