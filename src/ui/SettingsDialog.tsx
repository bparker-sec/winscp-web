import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';
import { diag, type DiagEvent, type LogLevel } from '../diagnostics/log';
import { sdkProbeHost } from '../sdk/client';
import { versionLabel } from '../buildInfo';

const VAULT_LOCK_OPTIONS = [
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '60 minutes' },
  { value: 0, label: 'Never' },
];

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function levelClass(level: LogLevel): string {
  switch (level) {
    case 'error':
      return 'text-danger';
    case 'warn':
      return 'text-amber-500';
    default:
      return 'text-muted';
  }
}

function EventRow({ event }: { event: DiagEvent }) {
  return (
    <div className="py-1 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-muted text-[11px] tabular-nums shrink-0">{fmtTime(event.time)}</span>
        <span className={`text-[11px] uppercase font-medium shrink-0 ${levelClass(event.level)}`}>
          {event.level}
        </span>
        {event.code && (
          <span className="font-mono text-[10px] px-1 rounded bg-black/5 dark:bg-white/10 text-muted shrink-0">
            {event.code}
          </span>
        )}
        <span className="text-[12px] break-words">{event.message}</span>
      </div>
      {event.detail && <div className="text-muted text-[11px] pl-[62px] break-words">{event.detail}</div>}
    </div>
  );
}

type ProbeState = 'checking' | boolean;

export function SettingsDialog() {
  const { closeSettings, local, remote, userName, vaultLockMinutes, setVaultLockMinutes } = useApp();
  const [events, setEvents] = useState<DiagEvent[]>(() => diag.getEvents());
  const [hostBridge, setHostBridge] = useState<ProbeState>('checking');
  const [copied, setCopied] = useState(false);

  useEffect(() => diag.subscribe(setEvents), []);

  useEffect(() => {
    let alive = true;
    setHostBridge('checking');
    sdkProbeHost().then((ok) => {
      if (alive) setHostBridge(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const oneDriveStatus = local ? `connected${userName ? ` (${userName})` : ''}` : 'not connected';
  const remoteStatus = remote ? `connected (${remote.label})` : 'not connected';
  const hostBridgeStatus = hostBridge === 'checking' ? 'checking…' : hostBridge ? 'available' : 'unavailable';

  const ordered = [...events].reverse();

  const buildDump = (): string => {
    const lines = [
      'WinSCP Web diagnostics',
      `Host bridge: ${hostBridgeStatus}`,
      `OneDrive: ${oneDriveStatus}`,
      `Remote: ${remoteStatus}`,
      `Version: ${versionLabel}`,
      '',
      ...ordered.map((e) => {
        const parts = [fmtTime(e.time), e.level.toUpperCase()];
        if (e.code) parts.push(`[${e.code}]`);
        parts.push(e.message);
        const line = parts.join(' ');
        return e.detail ? `${line}\n  ${e.detail}` : line;
      }),
    ];
    return lines.join('\n');
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildDump());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, insecure context); silently ignore.
    }
  };

  return (
    <Modal title="Settings" onClose={closeSettings}>
      <div className="flex flex-col gap-4">
        <section>
          <h3 className="text-[12px] uppercase tracking-wide text-muted mb-1">Diagnostics</h3>
          <div className="text-[12px] flex flex-col gap-0.5 border border-border rounded px-2 py-1.5">
            <div>Host bridge: {hostBridgeStatus}</div>
            <div>OneDrive: {oneDriveStatus}</div>
            <div>Remote: {remoteStatus}</div>
          </div>
        </section>

        <section>
          <h3 className="text-[12px] uppercase tracking-wide text-muted mb-1">Security</h3>
          <div className="text-[12px] flex flex-col gap-1 border border-border rounded px-2 py-1.5">
            <label className="flex items-center gap-2">
              <span className="shrink-0">Auto-lock vault after</span>
              <select
                className="h-7 px-1 rounded border border-border bg-transparent"
                value={vaultLockMinutes}
                onChange={(e) => setVaultLockMinutes(Number(e.target.value))}
              >
                {VAULT_LOCK_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-muted text-[11px]">
              How long saved-connection secrets stay unlocked after you enter the master passphrase.
            </div>
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-[12px] uppercase tracking-wide text-muted">Event log</h3>
            <span className="text-muted text-[11px]">({events.length})</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="text-[11px] text-muted underline hover:text-accent"
                onClick={() => diag.clear()}
              >
                Clear log
              </button>
              <button
                type="button"
                className="text-[11px] text-muted underline hover:text-accent"
                onClick={() => void onCopy()}
              >
                {copied ? 'Copied' : 'Copy diagnostics'}
              </button>
            </div>
          </div>
          <div className="border border-border rounded px-2 py-1 max-h-64 overflow-auto">
            {ordered.length === 0 ? (
              <div className="text-muted text-[12px] py-2 text-center">No events yet.</div>
            ) : (
              ordered.map((e) => <EventRow key={e.id} event={e} />)
            )}
          </div>
        </section>

        <div className="text-[11px] text-muted">WinSCP Web — {versionLabel}</div>

        <div className="flex justify-end">
          <button type="button" className="h-8 px-3 rounded border border-border" onClick={closeSettings}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
