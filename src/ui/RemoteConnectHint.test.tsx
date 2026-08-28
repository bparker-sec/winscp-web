import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemoteConnectHint } from './RemoteConnectHint';
import { useApp } from '../state/AppProvider';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

describe('RemoteConnectHint', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it('the Connect button calls openConnectDialog', () => {
    const openConnectDialog = vi.fn();
    mockUseApp.mockReturnValue({
      openConnectDialog,
      openConnectionManager: vi.fn(),
      remoteError: null,
    });
    render(<RemoteConnectHint />);
    fireEvent.click(screen.getByRole('button', { name: /^connect/i }));
    expect(openConnectDialog).toHaveBeenCalled();
  });

  it('the Saved connections link calls openConnectionManager', () => {
    const openConnectionManager = vi.fn();
    mockUseApp.mockReturnValue({
      openConnectDialog: vi.fn(),
      openConnectionManager,
      remoteError: null,
    });
    render(<RemoteConnectHint />);
    fireEvent.click(screen.getByRole('button', { name: /saved connections/i }));
    expect(openConnectionManager).toHaveBeenCalled();
  });

  it('shows remoteError when present', () => {
    mockUseApp.mockReturnValue({
      openConnectDialog: vi.fn(),
      openConnectionManager: vi.fn(),
      remoteError: 'boom',
    });
    render(<RemoteConnectHint />);
    expect(screen.getByRole('alert').textContent).toMatch(/boom/i);
  });
});
