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
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    move: vi.fn(),
    openRead: vi.fn(),
    openWrite: vi.fn(),
  } as unknown as FileSystem;
}

const rootEntries: FsEntry[] = [
  { name: 'a.txt', path: '/a.txt', kind: 'file', size: 10 },
  { name: 'sub', path: '/sub', kind: 'dir' },
];

describe('PaneView per-pane actions', () => {
  it('creates a new folder via the New folder button', async () => {
    const fs = fakeFs(rootEntries);
    render(<PaneView fs={fs} header="Test" />);
    await screen.findByText('a.txt');

    fireEvent.click(screen.getByTitle('New folder'));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'newdir' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      expect(fs.mkdir).toHaveBeenCalledWith('/newdir');
    });
  });

  it('deletes the selected item via the Delete button', async () => {
    const fs = fakeFs(rootEntries);
    render(<PaneView fs={fs} header="Test" />);
    await screen.findByText('a.txt');

    fireEvent.click(screen.getByText('a.txt'));
    fireEvent.click(screen.getByTitle('Delete'));
    await screen.findByText(/Delete 1 item/);
    fireEvent.click(screen.getByText('Delete', { selector: 'button[type="submit"]' }));

    await waitFor(() => {
      expect(fs.remove).toHaveBeenCalledWith('/a.txt', false);
    });
  });

  it('Up is disabled at root, enabled after navigating into a dir, and navigates back to root', async () => {
    const fs = fakeFs(rootEntries);
    render(<PaneView fs={fs} header="Test" />);
    await screen.findByText('a.txt');

    const upButton = screen.getByTitle('Up') as HTMLButtonElement;
    expect(upButton.disabled).toBe(true);

    fireEvent.doubleClick(screen.getByText('sub'));
    await waitFor(() => {
      expect((fs.list as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('/sub');
    });
    expect(upButton.disabled).toBe(false);

    fireEvent.click(upButton);
    await waitFor(() => {
      expect((fs.list as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('/');
    });
  });

  it('does not render a ".." row', async () => {
    const fs = fakeFs(rootEntries);
    render(<PaneView fs={fs} header="Test" initialPath="/sub" />);
    await waitFor(() => {
      expect((fs.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/\.\./)).toBeNull();
  });

  it('bumping refreshSignal re-lists the current cwd without resetting cwd or selection', async () => {
    const fs = fakeFs(rootEntries);
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <PaneView fs={fs} header="Test" refreshSignal={0} onSelectionChange={onSelectionChange} />,
    );
    await screen.findByText('a.txt');

    // Select a row, then confirm the initial list call count before refreshing.
    fireEvent.click(screen.getByText('a.txt'));
    await waitFor(() => {
      expect(onSelectionChange.mock.calls.at(-1)?.[0]).toHaveLength(1);
    });
    const callsBefore = (fs.list as ReturnType<typeof vi.fn>).mock.calls.length;

    rerender(<PaneView fs={fs} header="Test" refreshSignal={1} onSelectionChange={onSelectionChange} />);

    await waitFor(() => {
      expect((fs.list as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1);
    });
    // Same cwd is re-listed.
    expect((fs.list as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('/');
    // Selection is left untouched by the refresh.
    expect(onSelectionChange.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(screen.getByText('a.txt').closest('div')?.className).toMatch(/\bselected\b/);
  });
});
