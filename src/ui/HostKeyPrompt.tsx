import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';

export function HostKeyPrompt() {
  const { hostKeyPrompt, resolveHostKey } = useApp();
  if (!hostKeyPrompt) return null;

  const { host, fingerprint, status } = hostKeyPrompt;

  return (
    <Modal title="Verify host key" onClose={() => resolveHostKey(false)}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div>
          Host: <span className="font-mono">{host}</span>
        </div>
        <div>
          Fingerprint: <span className="font-mono break-all">{fingerprint}</span>
        </div>
        {status === 'mismatch' ? (
          <div className="text-danger font-bold">WARNING: the host key has CHANGED since last time.</div>
        ) : (
          <div className="text-muted">First time connecting to this host.</div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            className="h-8 px-3 rounded border border-border"
            onClick={() => resolveHostKey(false)}
          >
            Reject
          </button>
          <button
            type="button"
            className="h-8 px-4 rounded bg-accent text-accent-fg"
            onClick={() => resolveHostKey(true)}
          >
            Accept
          </button>
        </div>
      </div>
    </Modal>
  );
}
