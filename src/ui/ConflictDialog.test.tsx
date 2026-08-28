import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConflictDialog } from './ConflictDialog';
import { useApp } from '../state/AppProvider';

vi.mock('../state/AppProvider', () => ({
  useApp: vi.fn(),
}));

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

describe('ConflictDialog', () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it('renders nothing when conflictPrompt is null', () => {
    mockUseApp.mockReturnValue({ conflictPrompt: null, resolveConflict: vi.fn() });
    const { container } = render(<ConflictDialog />);
    expect(container.textContent).toBe('');
  });

  it('Overwrite calls resolveConflict("overwrite", false) by default', () => {
    const resolveConflict = vi.fn();
    mockUseApp.mockReturnValue({ conflictPrompt: { name: 'a.txt' }, resolveConflict });
    render(<ConflictDialog />);
    fireEvent.click(screen.getByRole('button', { name: /overwrite/i }));
    expect(resolveConflict).toHaveBeenCalledWith('overwrite', false);
  });

  it('Skip calls resolveConflict("skip", false)', () => {
    const resolveConflict = vi.fn();
    mockUseApp.mockReturnValue({ conflictPrompt: { name: 'a.txt' }, resolveConflict });
    render(<ConflictDialog />);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(resolveConflict).toHaveBeenCalledWith('skip', false);
  });

  it('Rename calls resolveConflict("rename", false)', () => {
    const resolveConflict = vi.fn();
    mockUseApp.mockReturnValue({ conflictPrompt: { name: 'a.txt' }, resolveConflict });
    render(<ConflictDialog />);
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    expect(resolveConflict).toHaveBeenCalledWith('rename', false);
  });

  it('checking "Apply to all" passes true through to resolveConflict', () => {
    const resolveConflict = vi.fn();
    mockUseApp.mockReturnValue({ conflictPrompt: { name: 'a.txt' }, resolveConflict });
    render(<ConflictDialog />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /overwrite/i }));
    expect(resolveConflict).toHaveBeenCalledWith('overwrite', true);
  });
});
