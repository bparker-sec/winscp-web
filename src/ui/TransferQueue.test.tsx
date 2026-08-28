import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransferQueue } from './TransferQueue';
import { useApp } from '../state/AppProvider';
import type { TransferJob } from '../transfer/queue';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

function job(overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id: 'j1',
    name: 'file.txt',
    direction: 'up',
    src: {} as never,
    srcPath: '/local/file.txt',
    dst: {} as never,
    dstPath: '/remote/file.txt',
    size: 100,
    isDir: false,
    state: 'active',
    bytes: 40,
    ...overrides,
  };
}

describe('TransferQueue', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it('shows "No transfers." when the queue is empty', () => {
    mockUseApp.mockReturnValue({
      jobs: [],
      cancelJob: vi.fn(),
      cancelAllJobs: vi.fn(),
      retryJob: vi.fn(),
      clearFinished: vi.fn(),
    });
    render(<TransferQueue />);
    expect(screen.getByText(/no transfers/i)).toBeTruthy();
  });

  it('renders a job name, its percentage while active, and a Cancel button that calls cancelJob', () => {
    const cancelJob = vi.fn();
    mockUseApp.mockReturnValue({
      jobs: [job()],
      cancelJob,
      cancelAllJobs: vi.fn(),
      retryJob: vi.fn(),
      clearFinished: vi.fn(),
    });
    render(<TransferQueue />);
    expect(screen.getByText('file.txt')).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelJob).toHaveBeenCalledWith('j1');
  });

  it('shows a Retry button for an errored job that calls retryJob', () => {
    const retryJob = vi.fn();
    mockUseApp.mockReturnValue({
      jobs: [job({ state: 'error', error: 'boom' })],
      cancelJob: vi.fn(),
      cancelAllJobs: vi.fn(),
      retryJob,
      clearFinished: vi.fn(),
    });
    render(<TransferQueue />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retryJob).toHaveBeenCalledWith('j1');
  });
});
