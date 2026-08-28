import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectDialog } from './ConnectDialog';
import { useApp } from '../state/AppProvider';
import { parseOpenSshPrivateKey } from '../ssh/privatekey';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

vi.mock('../ssh/privatekey', () => ({
  parseOpenSshPrivateKey: vi.fn(),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;
const mockParseKey = parseOpenSshPrivateKey as unknown as ReturnType<typeof vi.fn>;

function setup(overrides: Partial<ReturnType<typeof useApp>> = {}) {
  const remoteConnect = vi.fn();
  const closeConnectDialog = vi.fn();
  mockUseApp.mockReturnValue({
    remoteConnecting: false,
    remoteError: null,
    remoteConnect,
    closeConnectDialog,
    ...overrides,
  });
  return { remoteConnect, closeConnectDialog };
}

describe('ConnectDialog', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    mockParseKey.mockReset();
  });

  it('renders host and username fields', () => {
    setup();
    render(<ConnectDialog />);
    expect(screen.getByText(/^host$/i)).toBeTruthy();
    expect(screen.getByText(/^username$/i)).toBeTruthy();
  });

  it('switching to key method shows the private key textarea', () => {
    setup();
    render(<ConnectDialog />);
    expect(screen.queryByPlaceholderText(/BEGIN OPENSSH PRIVATE KEY/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/private key/i));
    expect(screen.getByPlaceholderText(/BEGIN OPENSSH PRIVATE KEY/)).toBeTruthy();
  });

  it('shows inline error and does not call remoteConnect on invalid key', () => {
    mockParseKey.mockImplementation(() => {
      throw new Error('bad key');
    });
    const { remoteConnect } = setup();
    render(<ConnectDialog />);

    fireEvent.change(screen.getByText(/^host$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'example.com' },
    });
    fireEvent.change(screen.getByText(/^username$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'bob' },
    });
    fireEvent.click(screen.getByLabelText(/private key/i));
    fireEvent.change(screen.getByPlaceholderText(/BEGIN OPENSSH PRIVATE KEY/), {
      target: { value: 'not a real key' },
    });

    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));

    expect(screen.getByRole('alert').textContent).toMatch(/unsupported or invalid/i);
    expect(remoteConnect).not.toHaveBeenCalled();
  });

  it('submits valid password creds via remoteConnect', () => {
    const { remoteConnect } = setup();
    render(<ConnectDialog />);

    fireEvent.change(screen.getByText(/^host$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'example.com' },
    });
    fireEvent.change(screen.getByText(/^username$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'bob' },
    });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, {
      target: { value: 'hunter2' },
    });

    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));

    expect(remoteConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'example.com',
        username: 'bob',
        password: 'hunter2',
        port: 22,
      }),
    );
  });
});
