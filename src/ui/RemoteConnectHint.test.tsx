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

  it('the button calls openConnectDialog', () => {
    const openConnectDialog = vi.fn();
    mockUseApp.mockReturnValue({
      openConnectDialog,
      remoteError: null,
    });
    render(<RemoteConnectHint />);
    fireEvent.click(screen.getByRole('button'));
    expect(openConnectDialog).toHaveBeenCalled();
  });

  it('shows remoteError when present', () => {
    mockUseApp.mockReturnValue({
      openConnectDialog: vi.fn(),
      remoteError: 'boom',
    });
    render(<RemoteConnectHint />);
    expect(screen.getByRole('alert').textContent).toMatch(/boom/i);
  });
});
