import { useState } from 'react';
import { useApp } from '../state/AppProvider';
import { MenuBar } from '../ui/MenuBar';
import { Toolbar } from '../ui/Toolbar';
import { StatusBar } from '../ui/StatusBar';
import { PaneView } from '../ui/PaneView';
import { TransferQueue } from '../ui/TransferQueue';
import { ConnectHint } from '../ui/ConnectHint';
import { RemoteConnectHint } from '../ui/RemoteConnectHint';
import { ConnectDialog } from '../ui/ConnectDialog';
import { HostKeyPrompt } from '../ui/HostKeyPrompt';

export function TabbedSingle() {
  const {
    theme,
    local,
    remote,
    remoteHome,
    remoteDisconnect,
    connectDialogOpen,
    hostKeyPrompt,
    connecting,
    connectError,
    userName,
    connect,
    disconnect,
  } = useApp();
  const [side, setSide] = useState<'local' | 'remote'>('local');

  return (
    <div className="flex flex-col h-full">
      <MenuBar
        sessionLabel={remote?.label ?? 'not connected'}
        theme={theme}
        compact
        signedIn={local !== null}
        connecting={connecting}
        userName={userName}
        onConnect={connect}
        onDisconnect={disconnect}
      />
      <div className="flex gap-1 p-1 bg-surface border-b border-border">
        <button
          className={`flex-1 h-7 rounded ${side === 'local' ? 'bg-accent text-accent-fg' : 'text-text'}`}
          onClick={() => setSide('local')}
        >
          ☁ {local?.label ?? 'OneDrive'}
        </button>
        <button
          className={`flex-1 h-7 rounded ${side === 'remote' ? 'bg-accent text-accent-fg' : 'text-text'}`}
          onClick={() => setSide('remote')}
        >
          🖥 {remote?.label ?? 'remote'}
        </button>
      </div>
      <Toolbar />
      <div className="flex-1 min-h-0">
        {side === 'local' ? (
          local ? (
            <PaneView fs={local} header={local.label} />
          ) : (
            <ConnectHint connecting={connecting} error={connectError} onConnect={connect} />
          )
        ) : remote ? (
          <PaneView fs={remote} header={remote.label} initialPath={remoteHome} onDisconnect={remoteDisconnect} />
        ) : (
          <RemoteConnectHint />
        )}
      </div>
      <TransferQueue items={[]} />
      <StatusBar left={side === 'local' ? (local?.label ?? 'OneDrive') : (remote?.label ?? 'remote')} />
      {connectDialogOpen && <ConnectDialog />}
      {hostKeyPrompt && <HostKeyPrompt />}
    </div>
  );
}
