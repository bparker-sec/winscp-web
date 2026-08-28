import { useApp } from '../state/AppProvider';
import { MenuBar } from '../ui/MenuBar';
import { Toolbar } from '../ui/Toolbar';
import { StatusBar } from '../ui/StatusBar';
import { Splitter } from '../ui/Splitter';
import { PaneView } from '../ui/PaneView';
import { TransferQueue } from '../ui/TransferQueue';
import { ConnectHint } from '../ui/ConnectHint';
import { RemoteConnectHint } from '../ui/RemoteConnectHint';
import { ConnectDialog } from '../ui/ConnectDialog';
import { HostKeyPrompt } from '../ui/HostKeyPrompt';
import { ConnectionManager } from '../ui/ConnectionManager';
import { MasterPassphraseDialog } from '../ui/MasterPassphraseDialog';

export function Commander() {
  const {
    theme,
    local,
    remote,
    remoteHome,
    remoteDisconnect,
    connectDialogOpen,
    hostKeyPrompt,
    splitRatio,
    setSplitRatio,
    connecting,
    connectError,
    userName,
    connect,
    disconnect,
    connectionManagerOpen,
    passphraseDialog,
  } = useApp();
  return (
    <div className="flex flex-col h-full">
      <MenuBar
        sessionLabel={remote?.label ?? 'not connected'}
        theme={theme}
        signedIn={local !== null}
        connecting={connecting}
        userName={userName}
        onConnect={connect}
        onDisconnect={disconnect}
      />
      <Toolbar />
      <div className="flex flex-1 min-h-0">
        <div style={{ width: `${splitRatio * 100}%` }} className="min-w-0 border-r border-border">
          {local ? (
            <PaneView fs={local} header={local.label} />
          ) : (
            <ConnectHint connecting={connecting} error={connectError} onConnect={connect} />
          )}
        </div>
        <Splitter ratio={splitRatio} onRatio={setSplitRatio} />
        <div className="flex-1 min-w-0">
          {remote ? (
            <PaneView fs={remote} header={remote.label} initialPath={remoteHome} onDisconnect={remoteDisconnect} />
          ) : (
            <RemoteConnectHint />
          )}
        </div>
      </div>
      <TransferQueue items={[]} />
      <StatusBar
        left={local ? `Local: ${local.label}` : 'Local: not connected'}
        right={remote ? `Remote: ${remote.label}` : 'Remote: not connected'}
      />
      {connectDialogOpen && <ConnectDialog />}
      {hostKeyPrompt && <HostKeyPrompt />}
      {connectionManagerOpen && <ConnectionManager />}
      {passphraseDialog && <MasterPassphraseDialog />}
    </div>
  );
}
