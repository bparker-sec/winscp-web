import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SettingsDialog } from './SettingsDialog';
import { useApp } from '../state/AppProvider';
import { diag } from '../diagnostics/log';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

vi.mock('../sdk/client', () => ({
  sdkProbeHost: vi.fn().mockResolvedValue(true),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

describe('SettingsDialog', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    diag.clear();
    mockUseApp.mockReturnValue({
      closeSettings: vi.fn(),
      local: null,
      remote: null,
      userName: undefined,
    });
  });

  afterEach(() => {
    diag.clear();
  });

  it('renders a logged error event with its message and code', async () => {
    diag.error('Transfer failed: file.txt', { code: 'permission-denied', detail: 'stack trace here' });
    render(<SettingsDialog />);
    expect(await screen.findByText('Transfer failed: file.txt')).toBeTruthy();
    expect(screen.getByText('permission-denied')).toBeTruthy();
    expect(screen.getByText('stack trace here')).toBeTruthy();
    await screen.findByText(/host bridge: available/i);
  });

  it('Clear log empties the event list', async () => {
    diag.info('hello there');
    render(<SettingsDialog />);
    expect(await screen.findByText('hello there')).toBeTruthy();
    await screen.findByText(/host bridge: available/i);
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: /clear log/i }));
    await waitFor(() => expect(screen.queryByText('hello there')).toBeNull());
    expect(screen.getByText(/no events yet/i)).toBeTruthy();
  });

  it('shows probe-derived status lines', async () => {
    mockUseApp.mockReturnValue({
      closeSettings: vi.fn(),
      local: { label: 'OneDrive' } as never,
      remote: { label: 'example.com' } as never,
      userName: 'Bob',
    });
    render(<SettingsDialog />);
    await waitFor(() => expect(screen.getByText(/host bridge: available/i)).toBeTruthy());
    expect(screen.getByText(/onedrive: connected \(bob\)/i)).toBeTruthy();
    expect(screen.getByText(/remote: connected \(example\.com\)/i)).toBeTruthy();
  });
});
