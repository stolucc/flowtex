// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ProjectUnlockModal from '../ProjectUnlockModal.jsx';

vi.mock('../../api.js', () => ({
  get: vi.fn(() => Promise.resolve({ json: async () => ({ passphraseHint: 'my hint' }) })),
  post: vi.fn(),
}));

import { get, post } from '../../api.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ProjectUnlockModal', () => {
  it('shows the passphrase hint fetched from /encryption', async () => {
    render(<ProjectUnlockModal projectId="p1" onUnlocked={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Hint: my hint/)).toBeTruthy());
    expect(get).toHaveBeenCalledWith('/api/projects/p1/encryption');
  });

  it('calls onUnlocked after a successful unlock', async () => {
    post.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const onUnlocked = vi.fn();
    render(<ProjectUnlockModal projectId="p1" onUnlocked={onUnlocked} />);

    fireEvent.change(screen.getByLabelText(/Passphrase or recovery code/i), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/api/projects/p1/unlock', { secret: 'secret' });
  });

  it('shows an error on wrong secret and does not call onUnlocked', async () => {
    post.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'nope' }) });
    const onUnlocked = vi.fn();
    render(<ProjectUnlockModal projectId="p1" onUnlocked={onUnlocked} />);

    fireEvent.change(screen.getByLabelText(/Passphrase or recovery code/i), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

    await waitFor(() => expect(screen.getByText(/Incorrect passphrase or recovery code/i)).toBeTruthy());
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('surfaces the rate-limit message on 429', async () => {
    post.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: 'Too many attempts. Wait a few minutes.' }) });
    render(<ProjectUnlockModal projectId="p1" onUnlocked={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Passphrase or recovery code/i), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    await waitFor(() => expect(screen.getByText(/Too many attempts/i)).toBeTruthy());
  });

  it('renders a Back button when onCancel is provided', () => {
    render(<ProjectUnlockModal projectId="p1" onUnlocked={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy();
  });
});
