import { useState } from 'react';
import { useApp } from '../state/AppProvider';
import { MenuBar } from '../ui/MenuBar';
import { StatusBar } from '../ui/StatusBar';
import { PaneView } from '../ui/PaneView';
import { TransferQueue } from '../ui/TransferQueue';
import { ConnectHint } from '../ui/ConnectHint';
import { RemoteConnectHint } from '../ui/RemoteConnectHint';
import { ConnectDialog } from '../ui/ConnectDialog';
import { HostKeyPrompt } from '../ui/HostKeyPrompt';
import { ConnectionManager } from '../ui/ConnectionManager';
import { MasterPassphraseDialog } from '../ui/MasterPassphraseDialog';
import { ConflictDialog } from '../ui/ConflictDialog';
import { SettingsDialog } from '../ui/SettingsDialog';
import { SyncDialog } from '../ui/SyncDialog';

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
    connectionManagerOpen,
    passphraseDialog,
    conflictPrompt,
    settingsOpen,
    syncOpen,
    localCwd,
    remoteCwd,
    setLocalCwd,
    setRemoteCwd,
    localSelection,
    remoteSelection,
    setLocalSelection,
    setRemoteSelection,
    enqueueTransfer,
    localRefreshNonce,
    remoteRefreshNonce,
  } = useApp();
  const [side, setSide] = useState<'local' | 'remote'>('local');

  const uploadToRemote = () => localSelection.length && enqueueTransfer({ from: 'local', entries: localSelection, toDir: remoteCwd });
  const downloadToLocal = () => remoteSelection.length && enqueueTransfer({ from: 'remote', entries: remoteSelection, toDir: localCwd });

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
      <div className="flex-1 min-h-0">
        {side === 'local' ? (
          local ? (
            <PaneView
              fs={local}
              header={local.label}
              side="local"
              onCwdChange={setLocalCwd}
              onSelectionChange={setLocalSelection}
              onTransferOut={() => uploadToRemote()}
              refreshSignal={localRefreshNonce}
            />
          ) : (
            <ConnectHint connecting={connecting} error={connectError} onConnect={connect} />
          )
        ) : remote ? (
          <PaneView
            fs={remote}
            header={remote.label}
            initialPath={remoteHome}
            side="remote"
            onDisconnect={remoteDisconnect}
            onCwdChange={setRemoteCwd}
            onSelectionChange={setRemoteSelection}
            onTransferOut={() => downloadToLocal()}
            refreshSignal={remoteRefreshNonce}
          />
        ) : (
          <RemoteConnectHint />
        )}
      </div>
      <TransferQueue />
      <StatusBar left={side === 'local' ? (local?.label ?? 'OneDrive') : (remote?.label ?? 'remote')} />
      {connectDialogOpen && <ConnectDialog />}
      {hostKeyPrompt && <HostKeyPrompt />}
      {connectionManagerOpen && <ConnectionManager />}
      {passphraseDialog && <MasterPassphraseDialog />}
      {conflictPrompt && <ConflictDialog />}
      {settingsOpen && <SettingsDialog />}
      {syncOpen && <SyncDialog />}
    </div>
  );
}
