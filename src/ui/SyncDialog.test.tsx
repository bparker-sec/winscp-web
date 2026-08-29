import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SyncDialog } from './SyncDialog';
import { useApp } from '../state/AppProvider';

vi.mock('../state/AppProvider', () => ({ useApp: vi.fn() }));
const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

function setup(overrides: Record<string, unknown> = {}) {
  const previewSync = vi.fn(async () => ({ copy: 3, mkdir: 1, del: 0, bytes: 2048, actions: [] }));
  const applySync = vi.fn(async () => {});
  const closeSync = vi.fn();
  mockUseApp.mockReturnValue({
    closeSync,
    previewSync,
    applySync,
    localCwd: '/docs',
    remoteCwd: '/home/ben',
    ...overrides,
  });
  return { previewSync, applySync, closeSync };
}

describe('SyncDialog', () => {
  beforeEach(() => mockUseApp.mockReset());

  it('previews a plan and enables Synchronize, then applies it', async () => {
    const { previewSync, applySync } = setup();
    render(<SyncDialog />);

    // Synchronize is disabled until a preview has run.
    const syncBtn = screen.getByRole('button', { name: 'Synchronize' });
    expect(syncBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(previewSync).toHaveBeenCalled());
    // Summary reflects the returned plan (byte total renders as one text node).
    await screen.findByText(/2\.0 KB/);

    // Preview populated a non-empty plan → Synchronize becomes enabled.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Synchronize' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Synchronize' }));
    await waitFor(() => expect(applySync).toHaveBeenCalledWith({ from: 'local', mode: 'update', compareBy: 'size-mtime' }));
  });

  it('reflects the chosen direction and mode in the request', async () => {
    const { previewSync } = setup();
    render(<SyncDialog />);

    fireEvent.click(screen.getByLabelText(/Server → OneDrive/i));
    fireEvent.click(screen.getByLabelText(/Mirror/i));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() =>
      expect(previewSync).toHaveBeenCalledWith({ from: 'remote', mode: 'mirror', compareBy: 'size-mtime' }),
    );
  });

  it('disables Synchronize when the preview finds nothing to do', async () => {
    setup({ previewSync: vi.fn(async () => ({ copy: 0, mkdir: 0, del: 0, bytes: 0, actions: [] })) });
    render(<SyncDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText(/already up to date/i);
    expect(screen.getByRole('button', { name: 'Synchronize' }).hasAttribute('disabled')).toBe(true);
  });
});
