import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PropertiesDialog } from './PropertiesDialog';
import type { FileSystem, FsEntry } from '../fs/FileSystem';

function baseFs(overrides: Partial<FileSystem> = {}): FileSystem {
  return {
    kind: 'mock',
    label: 'Test',
    list: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    openRead: vi.fn(),
    openWrite: vi.fn(),
    ...overrides,
  } as unknown as FileSystem;
}

const fileEntry: FsEntry = {
  name: 'report.txt',
  path: '/docs/report.txt',
  kind: 'file',
  size: 2048,
  mtime: Date.UTC(2024, 0, 2, 3, 4),
  mode: 0o644,
};

describe('PropertiesDialog', () => {
  it('renders name, size and kind', () => {
    render(
      <PropertiesDialog fs={baseFs()} entry={fileEntry} onClose={vi.fn()} onApplied={vi.fn()} />,
    );
    expect(screen.getByText('report.txt')).toBeTruthy();
    expect(screen.getByText('/docs/report.txt')).toBeTruthy();
    expect(screen.getByText('File')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('shows an editable permission editor when chmod is supported; octal updates and Apply calls chmod', async () => {
    const chmod = vi.fn().mockResolvedValue(undefined);
    const onApplied = vi.fn();
    const fs = baseFs({ chmod });
    render(
      <PropertiesDialog fs={fs} entry={fileEntry} onClose={vi.fn()} onApplied={onApplied} />,
    );

    // Mode 0o644 → octal display "0644".
    expect(screen.getByLabelText('octal permissions').textContent).toBe('0644');

    // Grant Group Write (bit 2 at group shift 3 → +0o020) → 0o664.
    fireEvent.click(screen.getByLabelText('Group Write'));
    expect(screen.getByLabelText('octal permissions').textContent).toBe('0664');

    // Grant Owner Exec (+0o100) → 0o764.
    fireEvent.click(screen.getByLabelText('Owner Exec'));
    expect(screen.getByLabelText('octal permissions').textContent).toBe('0764');

    fireEvent.click(screen.getByText('Apply'));
    await waitFor(() => expect(chmod).toHaveBeenCalledTimes(1));
    expect(chmod).toHaveBeenCalledWith('/docs/report.txt', 0o764);
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('shows read-only info with no permission editor when chmod is unsupported', () => {
    render(
      <PropertiesDialog fs={baseFs()} entry={fileEntry} onClose={vi.fn()} onApplied={vi.fn()} />,
    );
    expect(screen.queryByLabelText('octal permissions')).toBeNull();
    expect(screen.queryByText('Apply')).toBeNull();
    expect(screen.queryByLabelText('Owner Read')).toBeNull();
  });

  it('shows no editor when chmod exists but the entry has no numeric mode', () => {
    const fs = baseFs({ chmod: vi.fn() });
    const noMode: FsEntry = { name: 'x', path: '/x', kind: 'file', size: 1 };
    render(<PropertiesDialog fs={fs} entry={noMode} onClose={vi.fn()} onApplied={vi.fn()} />);
    expect(screen.queryByLabelText('octal permissions')).toBeNull();
  });
});
