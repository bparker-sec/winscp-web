import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HostKeyPrompt } from './HostKeyPrompt';
import { useApp } from '../state/AppProvider';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

describe('HostKeyPrompt', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it('shows the fingerprint text', () => {
    mockUseApp.mockReturnValue({
      hostKeyPrompt: { host: 'example.com:22', fingerprint: 'SHA256:abc123', status: 'new' },
      resolveHostKey: vi.fn(),
    });
    render(<HostKeyPrompt />);
    expect(screen.getByText(/SHA256:abc123/).textContent).toMatch(/SHA256:abc123/);
  });

  it('Accept calls resolveHostKey(true)', () => {
    const resolveHostKey = vi.fn();
    mockUseApp.mockReturnValue({
      hostKeyPrompt: { host: 'example.com:22', fingerprint: 'SHA256:abc123', status: 'new' },
      resolveHostKey,
    });
    render(<HostKeyPrompt />);
    fireEvent.click(screen.getByRole('button', { name: /accept/i }));
    expect(resolveHostKey).toHaveBeenCalledWith(true);
  });

  it('Reject calls resolveHostKey(false)', () => {
    const resolveHostKey = vi.fn();
    mockUseApp.mockReturnValue({
      hostKeyPrompt: { host: 'example.com:22', fingerprint: 'SHA256:abc123', status: 'mismatch' },
      resolveHostKey,
    });
    render(<HostKeyPrompt />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(resolveHostKey).toHaveBeenCalledWith(false);
  });

  it('shows a mismatch warning', () => {
    mockUseApp.mockReturnValue({
      hostKeyPrompt: { host: 'example.com:22', fingerprint: 'SHA256:abc123', status: 'mismatch' },
      resolveHostKey: vi.fn(),
    });
    render(<HostKeyPrompt />);
    expect(screen.getByText(/CHANGED/).textContent).toMatch(/WARNING/i);
  });

  it('renders nothing when hostKeyPrompt is null', () => {
    mockUseApp.mockReturnValue({
      hostKeyPrompt: null,
      resolveHostKey: vi.fn(),
    });
    const { container } = render(<HostKeyPrompt />);
    expect(container.textContent).toBe('');
  });
});
