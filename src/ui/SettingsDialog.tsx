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

const PIPELINE_DEPTH_OPTIONS = [
  { value: 1, label: 'Off (one at a time)' },
  { value: 4, label: 'Light' },
  { value: 8, label: 'Medium' },
  { value: 16, label: 'High' },
  { value: 32, label: 'Very high' },
  { value: 64, label: 'Maximum (fastest)' },
];

const TRANSFER_WINDOW_OPTIONS = [
  { value: 2, label: 'Small (2 MB)' },
  { value: 4, label: 'Medium (4 MB)' },
  { value: 8, label: 'Large (8 MB)' },
  { value: 16, label: 'Maximum (16 MB)' },
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
  const {
    closeSettings,
    local,
    remote,
    userName,
    vaultLockMinutes,
    setVaultLockMinutes,
    pipelineDepth,
    setPipelineDepth,
    transferWindowMB,
    setTransferWindowMB,
    enablePassphraseKeys,
    setEnablePassphraseKeys,
  } = useApp();
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
      'Skiff diagnostics',
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

            <label className="flex items-center gap-2 mt-1">
              <input
                type="checkbox"
                checked={enablePassphraseKeys}
                onChange={(e) => setEnablePassphraseKeys(e.target.checked)}
              />
              <span>Enable passphrase-protected SSH keys</span>
            </label>
            <div className="text-muted text-[11px]">
              Off by default to keep key setup simple. When on, the Connect dialog accepts a
              passphrase for an encrypted private key; the key is decrypted once and stored
              (protected by your master passphrase), so you won&apos;t be asked for the key passphrase
              again.
            </div>
          </div>
        </section>

        <section>
          <h3 className="text-[12px] uppercase tracking-wide text-muted mb-1">Transfer speed</h3>
          <div className="text-[12px] flex flex-col gap-3 border border-border rounded px-2 py-2">
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2">
                <span className="shrink-0">Send files in parallel</span>
                <select
                  className="h-7 px-1 rounded border border-border bg-transparent ml-auto"
                  value={pipelineDepth}
                  onChange={(e) => setPipelineDepth(Number(e.target.value))}
                >
                  {PIPELINE_DEPTH_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-muted text-[11px]">
                Normally each piece of a file is sent, then the app waits for the server to confirm it
                before sending the next — which wastes time on slow or long-distance connections. This
                sends several pieces at once so the connection stays busy and transfers finish much
                faster. Turn it down if your network is unreliable or you see transfer errors; “Off”
                is the safe, one-piece-at-a-time mode. Applies to new transfers.
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2">
                <span className="shrink-0">Download buffer size</span>
                <select
                  className="h-7 px-1 rounded border border-border bg-transparent ml-auto"
                  value={transferWindowMB}
                  onChange={(e) => setTransferWindowMB(Number(e.target.value))}
                >
                  {TRANSFER_WINDOW_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-muted text-[11px]">
                How much data the server is allowed to send at once while downloading, before it pauses
                to let the app catch up. A larger buffer keeps fast connections running at full speed;
                a smaller one uses less memory. This affects downloads only — uploads are controlled by
                the server. Takes effect the next time you connect.
              </div>
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

        <div className="text-[11px] text-muted">Skiff — {versionLabel}</div>

        <div className="flex justify-end">
          <button type="button" className="h-8 px-3 rounded border border-border" onClick={closeSettings}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
