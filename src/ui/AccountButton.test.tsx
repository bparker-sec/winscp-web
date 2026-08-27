import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountButton } from './AccountButton';

describe('AccountButton', () => {
  it('shows Connect when signed out', () => {
    render(<AccountButton signedIn={false} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByRole('button').textContent).toMatch(/connect onedrive/i);
  });
  it('disables and shows Connecting… while connecting', () => {
    render(<AccountButton signedIn={false} connecting onConnect={() => {}} onDisconnect={() => {}} />);
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/connecting/i);
  });
  it('exposes a sign-out aria-label with the user name', () => {
    render(<AccountButton signedIn userName="Ada" onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByRole('button', { name: /sign out of onedrive \(ada\)/i })).toBeTruthy();
  });
});
