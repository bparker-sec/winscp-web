import type { FsEntry } from '../fs/FileSystem';
import { useApp } from '../state/AppProvider';
import { MenuBar } from '../ui/MenuBar';
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
import { ConflictDialog } from '../ui/ConflictDialog';
import { SettingsDialog } from '../ui/SettingsDialog';
import { SyncDialog } from '../ui/SyncDialog';

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
    conflictPrompt,
    settingsOpen,
    syncOpen,
    localCwd,
    remoteCwd,
    setLocalCwd,
    setRemoteCwd,
    setLocalSelection,
    setRemoteSelection,
    enqueueTransfer,
    localRefreshNonce,
    remoteRefreshNonce,
  } = useApp();

  const uploadToRemote = (entries: FsEntry[]) =>
    entries.length && enqueueTransfer({ from: 'local', entries, toDir: remoteCwd });
  const downloadToLocal = (entries: FsEntry[]) =>
    entries.length && enqueueTransfer({ from: 'remote', entries, toDir: localCwd });

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
      <div className="flex flex-1 min-h-0">
        <div style={{ width: `${splitRatio * 100}%` }} className="min-w-0 border-r border-border">
          {local ? (
            <PaneView
              fs={local}
              header={local.label}
              side="local"
              onCwdChange={setLocalCwd}
              onSelectionChange={setLocalSelection}
              onTransferOut={uploadToRemote}
              onDropIn={downloadToLocal}
              refreshSignal={localRefreshNonce}
            />
          ) : (
            <ConnectHint connecting={connecting} error={connectError} onConnect={connect} />
          )}
        </div>
        <Splitter ratio={splitRatio} onRatio={setSplitRatio} />
        <div className="flex-1 min-w-0">
          {remote ? (
            <PaneView
              fs={remote}
              header={remote.label}
              initialPath={remoteHome}
              side="remote"
              onDisconnect={remoteDisconnect}
              onCwdChange={setRemoteCwd}
              onSelectionChange={setRemoteSelection}
              onTransferOut={downloadToLocal}
              onDropIn={uploadToRemote}
              refreshSignal={remoteRefreshNonce}
            />
          ) : (
            <RemoteConnectHint />
          )}
        </div>
      </div>
      <TransferQueue />
      <StatusBar
        left={local ? `Local: ${local.label}` : 'Local: not connected'}
        right={remote ? `Remote: ${remote.label}` : 'Remote: not connected'}
      />
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
