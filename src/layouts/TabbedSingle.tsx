import { useState } from 'react';
import { useApp } from '../state/AppProvider';
import { MenuBar } from '../ui/MenuBar';
import { Toolbar } from '../ui/Toolbar';
import { StatusBar } from '../ui/StatusBar';
import { PaneView } from '../ui/PaneView';
import { TransferQueue } from '../ui/TransferQueue';

export function TabbedSingle() {
  const { theme, local, remote } = useApp();
  const [side, setSide] = useState<'local' | 'remote'>('local');
  const fs = side === 'local' ? local : remote;

  return (
    <div className="flex flex-col h-full">
      <MenuBar sessionLabel={remote?.label ?? 'not connected'} theme={theme} compact />
      <div className="flex gap-1 p-1 bg-surface border-b border-border">
        <button
          className={`flex-1 h-7 rounded ${side === 'local' ? 'bg-accent text-accent-fg' : 'text-text'}`}
          onClick={() => setSide('local')}
        >
          ☁ {local.label}
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
        {fs ? <PaneView fs={fs} header={fs.label} /> : <div className="p-4 text-muted">Not connected.</div>}
      </div>
      <TransferQueue items={[]} />
      <StatusBar left={side === 'local' ? local.label : (remote?.label ?? 'remote')} />
    </div>
  );
}
