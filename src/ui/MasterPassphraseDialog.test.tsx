import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MasterPassphraseDialog } from './MasterPassphraseDialog';
import { useApp } from '../state/AppProvider';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

function setup(overrides: Partial<ReturnType<typeof useApp>> = {}) {
  const setMasterPassphrase = vi.fn().mockResolvedValue(undefined);
  const unlockVault = vi.fn().mockResolvedValue(true);
  const closePassphraseDialog = vi.fn();
  mockUseApp.mockReturnValue({
    passphraseDialog: { mode: 'set' },
    setMasterPassphrase,
    unlockVault,
    closePassphraseDialog,
    ...overrides,
  });
  return { setMasterPassphrase, unlockVault, closePassphraseDialog };
}

function passInput() {
  return screen.getByText(/^passphrase$/i).closest('label')!.querySelector('input')!;
}

function confirmInput() {
  return screen.getByText(/^confirm passphrase$/i).closest('label')!.querySelector('input')!;
}

describe('MasterPassphraseDialog', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it('set mode: mismatched confirm shows an error and does not call setMasterPassphrase', async () => {
    const { setMasterPassphrase } = setup({ passphraseDialog: { mode: 'set' } });
    render(<MasterPassphraseDialog />);

    fireEvent.change(passInput(), { target: { value: 'abc123' } });
    fireEvent.change(confirmInput(), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: /set passphrase/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/do not match/i);
    expect(setMasterPassphrase).not.toHaveBeenCalled();
  });

  it('set mode: matching passphrases calls setMasterPassphrase', async () => {
    const { setMasterPassphrase } = setup({ passphraseDialog: { mode: 'set' } });
    render(<MasterPassphraseDialog />);

    fireEvent.change(passInput(), { target: { value: 'abc123' } });
    fireEvent.change(confirmInput(), { target: { value: 'abc123' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /set passphrase/i }));
    });

    expect(setMasterPassphrase).toHaveBeenCalledWith('abc123');
  });

  it('unlock mode: shows "Incorrect passphrase" when unlockVault resolves false', async () => {
    const unlockVault = vi.fn().mockResolvedValue(false);
    setup({ passphraseDialog: { mode: 'unlock' }, unlockVault });
    render(<MasterPassphraseDialog />);

    fireEvent.change(passInput(), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/incorrect passphrase/i);
  });

  it('renders nothing when passphraseDialog is null', () => {
    setup({ passphraseDialog: null });
    const { container } = render(<MasterPassphraseDialog />);
    expect(container.textContent).toBe('');
  });
});
