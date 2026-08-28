import { useState } from 'react';
import { Modal } from './Modal';
import { useApp } from '../state/AppProvider';
import type { ConflictChoice } from '../transfer/queue';

export function ConflictDialog() {
  const { conflictPrompt, resolveConflict } = useApp();
  const [applyToAll, setApplyToAll] = useState(false);
  if (!conflictPrompt) return null;

  const choose = (choice: ConflictChoice) => resolveConflict(choice, applyToAll);

  return (
    <Modal title="File exists" onClose={() => choose('skip')}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div>
          <span className="font-mono">{conflictPrompt.name}</span> already exists in the destination.
        </div>
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
          />
          Apply to all
        </label>
        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            className="h-8 px-3 rounded border border-border"
            onClick={() => choose('skip')}
          >
            Skip
          </button>
          <button
            type="button"
            className="h-8 px-3 rounded border border-border"
            onClick={() => choose('rename')}
          >
            Rename
          </button>
          <button
            type="button"
            className="h-8 px-4 rounded bg-accent text-accent-fg"
            onClick={() => choose('overwrite')}
          >
            Overwrite
          </button>
        </div>
      </div>
    </Modal>
  );
}
