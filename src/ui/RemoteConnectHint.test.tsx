import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RemoteConnectHint } from './RemoteConnectHint';
import { useApp } from '../state/AppProvider';
import type { SavedConnection } from '../connections/store';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

const conns: SavedConnection[] = [
  {
    id: 'a',
    name: 'Alpha',
    protocol: 'sftp',
    host: 'alpha.example.com',
    port: 22,
    username: 'bob',
    authMethod: 'password',
    alwaysPrompt: false,
  },
  {
    id: 'b',
    name: 'Beta',
    protocol: 'sftp',
    host: 'beta.example.com',
    port: 2222,
    username: 'alice',
    authMethod: 'key',
    alwaysPrompt: true,
  },
];

function setup(overrides: Partial<ReturnType<typeof useApp>> = {}) {
  const connectSaved = vi.fn().mockResolvedValue(undefined);
  const openConnectDialog = vi.fn();
  const openConnectionManager = vi.fn();
  mockUseApp.mockReturnValue({
    connections: [],
    vaultState: 'unlocked',
    connectSaved,
    openConnectDialog,
    openConnectionManager,
    remoteError: null,
    ...overrides,
  });
  return { connectSaved, openConnectDialog, openConnectionManager };
}

describe('RemoteConnectHint', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it('shows "No saved connections." and a New connection… button when there are none', () => {
    setup();
    render(<RemoteConnectHint />);
    expect(screen.getByText(/no saved connections/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /new connection/i })).toBeTruthy();
  });

  it('New connection… calls openConnectDialog', () => {
    const { openConnectDialog } = setup();
    render(<RemoteConnectHint />);
    fireEvent.click(screen.getByRole('button', { name: /new connection/i }));
    expect(openConnectDialog).toHaveBeenCalled();
  });

  it('renders saved connection names and metadata', () => {
    setup({ connections: conns });
    render(<RemoteConnectHint />);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('bob@alpha.example.com:22')).toBeTruthy();
  });

  it('clicking a saved connection row calls connectSaved(id)', () => {
    const { connectSaved } = setup({ connections: conns });
    render(<RemoteConnectHint />);
    fireEvent.click(screen.getByText('Alpha').closest('button')!);
    expect(connectSaved).toHaveBeenCalledWith('a');
  });

  it('shows an "Unlock saved connections" affordance when the vault is locked', () => {
    const { openConnectionManager } = setup({ connections: conns, vaultState: 'locked' });
    render(<RemoteConnectHint />);
    fireEvent.click(screen.getByRole('button', { name: /unlock saved connections/i }));
    expect(openConnectionManager).toHaveBeenCalled();
  });

  it('shows remoteError when present', () => {
    setup({ remoteError: 'boom' });
    render(<RemoteConnectHint />);
    expect(screen.getByRole('alert').textContent).toMatch(/boom/i);
  });
});
