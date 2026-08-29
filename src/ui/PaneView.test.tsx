import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

const entriesWithHidden: FsEntry[] = [
  { name: '.env', path: '/.env', kind: 'file', size: 5 },
  { name: '.hidden', path: '/.hidden', kind: 'dir' },
  { name: 'visible.txt', path: '/visible.txt', kind: 'file', size: 10 },
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

    // Both selected rows must carry the visible "selected" highlight class.
    expect(screen.getByText('a.txt').closest('div')?.className).toMatch(/\bselected\b/);
    expect(screen.getByText('b.txt').closest('div')?.className).toMatch(/\bselected\b/);
  });
});

describe('PaneView drag-and-drop self-drop guard', () => {
  it('dropping back onto the same-side pane it was dragged from does not call onDropIn', async () => {
    const onDropIn = vi.fn();
    const fs = fakeFs(entries);
    const { container } = render(
      <PaneView fs={fs} header="Test" side="local" onDropIn={onDropIn} />,
    );

    await screen.findByText('a.txt');
    const row = screen.getByText('a.txt').closest('div')!;
    const fakeDataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };

    fireEvent.dragStart(row, { dataTransfer: fakeDataTransfer });
    fireEvent.drop(container.firstChild as Element, { dataTransfer: fakeDataTransfer });

    expect(onDropIn).not.toHaveBeenCalled();
  });

  it('dropping onto the OTHER side pane calls onDropIn with the dragged entries', async () => {
    const onDropIn = vi.fn();
    const fs = fakeFs(entries);
    const { container } = render(
      <PaneView fs={fs} header="Test" side="remote" onDropIn={onDropIn} />,
    );

    await screen.findByText('a.txt');
    const fakeDataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };

    // Simulate a drag that originated on the "local" side (a different pane instance
    // would normally start this; here we just drive the module-level currentDrag ref
    // via a dragStart on a "local"-side pane rendered separately).
    const other = render(<PaneView fs={fakeFs(entries)} header="Other" side="local" />);
    await within(other.container).findAllByText('a.txt');
    const otherRow = within(other.container).getAllByText('a.txt')[0].closest('div')!;
    fireEvent.dragStart(otherRow, { dataTransfer: fakeDataTransfer });
    expect(fakeDataTransfer.setData).toHaveBeenCalled();

    fireEvent.drop(container.firstChild as Element, { dataTransfer: fakeDataTransfer });

    expect(onDropIn).toHaveBeenCalledTimes(1);
    expect(onDropIn.mock.calls[0][0]).toHaveLength(1);
    expect(onDropIn.mock.calls[0][0][0].name).toBe('a.txt');
  });
});

describe('PaneView hidden-files toggle', () => {
  it('hides dotfiles by default and reveals them when toggled', async () => {
    const fs = fakeFs(entriesWithHidden);
    render(<PaneView fs={fs} header="Test" />);

    await screen.findByText('visible.txt');
    // Dotfiles hidden by default.
    expect(screen.queryByText('.env')).toBeNull();
    expect(screen.queryByText('.hidden')).toBeNull();

    // Toggle shows them.
    fireEvent.click(screen.getByTitle('Show hidden files'));
    await screen.findByText('.env');
    expect(screen.getByText('.hidden')).toBeTruthy();

    // Toggle again hides them.
    fireEvent.click(screen.getByTitle('Hide dotfiles'));
    await waitFor(() => expect(screen.queryByText('.env')).toBeNull());
  });
});

describe('PaneView Properties button', () => {
  it('is disabled unless exactly one entry is selected', async () => {
    const fs = fakeFs(entries);
    render(<PaneView fs={fs} header="Test" />);

    await screen.findByText('a.txt');
    const propsBtn = screen.getByTitle('Properties') as HTMLButtonElement;

    // No selection → disabled.
    expect(propsBtn.disabled).toBe(true);

    // One selected → enabled.
    fireEvent.click(screen.getByText('a.txt'));
    await waitFor(() => expect(propsBtn.disabled).toBe(false));

    // Two selected → disabled.
    fireEvent.click(screen.getByText('b.txt'), { ctrlKey: true });
    await waitFor(() => expect(propsBtn.disabled).toBe(true));
  });
});
