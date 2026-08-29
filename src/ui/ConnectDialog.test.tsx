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
  isEncryptedOpenSshKey: vi.fn(() => false),
  encodeUnencryptedOpenSshKey: vi.fn(
    () => '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n',
  ),
  EncryptedKeyError: class EncryptedKeyError extends Error {},
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;
const mockParseKey = parseOpenSshPrivateKey as unknown as ReturnType<typeof vi.fn>;

function setup(overrides: Partial<ReturnType<typeof useApp>> = {}) {
  const remoteConnect = vi.fn();
  const closeConnectDialog = vi.fn();
  const saveConnection = vi.fn().mockResolvedValue(undefined);
  mockUseApp.mockReturnValue({
    remoteConnecting: false,
    remoteError: null,
    remoteConnect,
    closeConnectDialog,
    connectDialogPrefill: null,
    saveConnection,
    enablePassphraseKeys: false,
    ...overrides,
  });
  return { remoteConnect, closeConnectDialog, saveConnection };
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
      throw new Error('Unsupported or invalid private key.');
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

  it('with "Save this connection" checked and a name, calls saveConnection with metadata and secret', () => {
    const { saveConnection } = setup();
    render(<ConnectDialog />);

    fireEvent.change(screen.getByText(/^host$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'example.com' },
    });
    fireEvent.change(screen.getByText(/^username$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'bob' },
    });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'hunter2' } });

    fireEvent.click(screen.getByLabelText(/save this connection/i));
    fireEvent.change(screen.getByText(/^name$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'My server' },
    });

    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));

    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My server',
        host: 'example.com',
        username: 'bob',
        protocol: 'sftp',
        authMethod: 'password',
        alwaysPrompt: false,
      }),
      'hunter2',
    );
  });

  it('with "Always prompt" checked, calls saveConnection with no secret', () => {
    const { saveConnection } = setup();
    render(<ConnectDialog />);

    fireEvent.change(screen.getByText(/^host$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'example.com' },
    });
    fireEvent.change(screen.getByText(/^username$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'bob' },
    });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'hunter2' } });

    fireEvent.click(screen.getByLabelText(/save this connection/i));
    fireEvent.click(screen.getByLabelText(/always prompt/i));

    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));

    expect(saveConnection).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('editing a prefilled connection without re-entering the password saves with the SAME id and no secret', () => {
    const { saveConnection } = setup({
      connectDialogPrefill: {
        id: 'existing-id',
        name: 'Old name',
        host: 'example.com',
        port: 22,
        username: 'bob',
        authMethod: 'password',
        alwaysPrompt: false,
      },
    });
    render(<ConnectDialog />);

    // Change a field, but do NOT retype the password.
    fireEvent.change(screen.getByText(/^name$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'New name' },
    });

    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));

    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'existing-id', name: 'New name' }),
      undefined,
    );
  });

  it('encrypted key with the passphrase setting OFF shows a Settings hint and does not connect', async () => {
    const { isEncryptedOpenSshKey } = await import('../ssh/privatekey');
    (isEncryptedOpenSshKey as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { remoteConnect } = setup({ enablePassphraseKeys: false });
    render(<ConnectDialog />);
    fireEvent.click(screen.getByLabelText(/private key/i));
    fireEvent.change(screen.getByPlaceholderText(/BEGIN OPENSSH PRIVATE KEY/), {
      target: { value: 'encrypted-key' },
    });
    fireEvent.change(screen.getByText(/^host$/i).closest('label')!.querySelector('input')!, { target: { value: 'h' } });
    fireEvent.change(screen.getByText(/^username$/i).closest('label')!.querySelector('input')!, { target: { value: 'u' } });
    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/settings/i);
    expect(remoteConnect).not.toHaveBeenCalled();
    (isEncryptedOpenSshKey as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('encrypted key with the setting ON decrypts with the passphrase, connects, and saves the DECRYPTED key', async () => {
    const { isEncryptedOpenSshKey, encodeUnencryptedOpenSshKey } = await import('../ssh/privatekey');
    (isEncryptedOpenSshKey as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockParseKey.mockReturnValue({ type: 'ssh-ed25519', seed: new Uint8Array(32), publicKey: new Uint8Array(32) });
    const { remoteConnect, saveConnection } = setup({ enablePassphraseKeys: true });
    render(<ConnectDialog />);
    fireEvent.click(screen.getByLabelText(/private key/i));
    fireEvent.change(screen.getByPlaceholderText(/BEGIN OPENSSH PRIVATE KEY/), { target: { value: 'enc-key' } });
    fireEvent.change(screen.getByText(/key passphrase/i).closest('label')!.querySelector('input')!, {
      target: { value: 'secret-pass' },
    });
    fireEvent.change(screen.getByText(/^host$/i).closest('label')!.querySelector('input')!, { target: { value: 'h' } });
    fireEvent.change(screen.getByText(/^username$/i).closest('label')!.querySelector('input')!, { target: { value: 'u' } });
    fireEvent.click(screen.getByLabelText(/save this connection/i));
    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));

    expect(mockParseKey).toHaveBeenCalledWith('enc-key', 'secret-pass');
    expect(remoteConnect).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'sftp' }));
    // Saved secret is the re-serialized DECRYPTED key, not the original encrypted PEM.
    expect(encodeUnencryptedOpenSshKey).toHaveBeenCalled();
    const savedSecret = (saveConnection as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(savedSecret).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(savedSecret).not.toBe('enc-key');
    (isEncryptedOpenSshKey as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('switching protocol to FTP hides the SFTP auth options and submits ftp creds', () => {
    const { remoteConnect } = setup();
    render(<ConnectDialog />);

    fireEvent.change(screen.getByText(/^protocol$/i).closest('label')!.querySelector('select')!, {
      target: { value: 'ftp' },
    });
    // No SSH key/auth-method radios for FTP; host/username/password remain.
    expect(screen.queryByLabelText(/private key/i)).toBeNull();
    fireEvent.change(screen.getByText(/^host$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'ftp.example.com' },
    });
    fireEvent.change(screen.getByText(/^username$/i).closest('label')!.querySelector('input')!, {
      target: { value: 'bob' },
    });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, {
      target: { value: 'pw' },
    });

    fireEvent.click(screen.getByRole('button', { name: /connect$/i }));
    expect(remoteConnect).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'ftp', host: 'ftp.example.com', username: 'bob', password: 'pw' }),
    );
  });

  it('only exposes SFTP and FTP in the protocol picker (WebDAV/S3 not wired into the GUI)', () => {
    setup();
    render(<ConnectDialog />);
    const opts = [...(screen.getByText(/^protocol$/i).closest('label')!.querySelectorAll('option'))].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(opts).toEqual(['sftp', 'ftp']);
  });
});
