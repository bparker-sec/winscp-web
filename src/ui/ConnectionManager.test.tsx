import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionManager } from './ConnectionManager';
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
  const deleteConnection = vi.fn();
  const duplicateConnection = vi.fn();
  const closeConnectionManager = vi.fn();
  const openConnectDialog = vi.fn();
  const openConnectDialogPrefilled = vi.fn();
  mockUseApp.mockReturnValue({
    connections: conns,
    vaultState: 'unlocked',
    closeConnectionManager,
    connectSaved,
    deleteConnection,
    duplicateConnection,
    openConnectDialog,
    openConnectDialogPrefilled,
    ...overrides,
  });
  return {
    connectSaved,
    deleteConnection,
    duplicateConnection,
    closeConnectionManager,
    openConnectDialog,
    openConnectDialogPrefilled,
  };
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders a list of connections with names visible', () => {
    setup();
    render(<ConnectionManager />);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('Connect calls connectSaved(id)', () => {
    const { connectSaved } = setup();
    render(<ConnectionManager />);
    const row = screen.getByText('Alpha').closest('li')!;
    fireEvent.click(row.querySelector('button')!);
    expect(connectSaved).toHaveBeenCalledWith('a');
  });

  it('Delete calls deleteConnection(id)', () => {
    const { deleteConnection } = setup();
    render(<ConnectionManager />);
    const row = screen.getByText('Beta').closest('li')!;
    const deleteBtn = Array.from(row.querySelectorAll('button')).find((b) => /delete/i.test(b.textContent ?? ''))!;
    fireEvent.click(deleteBtn);
    expect(deleteConnection).toHaveBeenCalledWith('b');
  });

  it('shows empty state text when there are no connections', () => {
    setup({ connections: [] });
    render(<ConnectionManager />);
    expect(screen.getByText(/no saved connections yet/i)).toBeTruthy();
  });
});
