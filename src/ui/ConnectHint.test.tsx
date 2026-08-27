import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectHint } from './ConnectHint';

describe('ConnectHint', () => {
  it('calls onConnect when clicked', () => {
    const onConnect = vi.fn();
    render(<ConnectHint connecting={false} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onConnect).toHaveBeenCalled();
  });
  it('shows an error with role=alert', () => {
    render(<ConnectHint connecting={false} error="nope" onConnect={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/nope/i);
  });
  it('disables the button while connecting', () => {
    render(<ConnectHint connecting onConnect={() => {}} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
