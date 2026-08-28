import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PaneView } from './PaneView';
import type { FileSystem, FsEntry } from '../fs/FileSystem';

function fakeFs(entries: FsEntry[]): FileSystem {
  return {
    kind: 'mock',
    label: 'Test',
    list: vi.fn().mockResolvedValue(entries),
    stat: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    openRead: vi.fn(),
    openWrite: vi.fn(),
  } as unknown as FileSystem;
}

const entries: FsEntry[] = [
  { name: 'a.txt', path: '/a.txt', kind: 'file', size: 10 },
  { name: 'b.txt', path: '/b.txt', kind: 'file', size: 20 },
];

describe('PaneView multi-select', () => {
  it('Ctrl-click adds to selection and reports 2 entries via onSelectionChange', async () => {
    const onSelectionChange = vi.fn();
    const fs = fakeFs(entries);
    render(<PaneView fs={fs} header="Test" onSelectionChange={onSelectionChange} />);

    await screen.findByText('a.txt');
    fireEvent.click(screen.getByText('a.txt'));
    fireEvent.click(screen.getByText('b.txt'), { ctrlKey: true });

    await waitFor(() => {
      const lastCall = onSelectionChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toHaveLength(2);
    });
  });
});
