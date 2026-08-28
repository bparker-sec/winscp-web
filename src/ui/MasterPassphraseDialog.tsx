import { useState } from 'react';
import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';

export function MasterPassphraseDialog() {
  const { passphraseDialog, setMasterPassphrase, unlockVault, closePassphraseDialog } = useApp();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!passphraseDialog) return null;
  const { mode } = passphraseDialog;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'set') {
      if (passphrase !== confirm) {
        setError('Passphrases do not match.');
        return;
      }
      setBusy(true);
      try {
        await setMasterPassphrase(passphrase);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const ok = await unlockVault(passphrase);
      if (!ok) {
        setError('Incorrect passphrase.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === 'set' ? 'Set master passphrase' : 'Unlock saved connections'}
      onClose={closePassphraseDialog}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[13px]">
          Passphrase
          <input
            type="password"
            className="h-8 px-2 rounded border border-border bg-transparent"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </label>

        {mode === 'set' && (
          <label className="flex flex-col gap-1 text-[13px]">
            Confirm passphrase
            <input
              type="password"
              className="h-8 px-2 rounded border border-border bg-transparent"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}

        <div className="text-muted text-[11px]">
          Protects saved secrets at rest in this browser.
        </div>

        {error && (
          <div role="alert" className="text-danger text-[12px]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <button type="button" className="h-8 px-3 rounded border border-border" onClick={closePassphraseDialog}>
            Cancel
          </button>
          <button
            type="submit"
            className="h-8 px-4 rounded bg-accent text-accent-fg disabled:opacity-60"
            disabled={busy}
          >
            {mode === 'set' ? 'Set passphrase' : 'Unlock'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
