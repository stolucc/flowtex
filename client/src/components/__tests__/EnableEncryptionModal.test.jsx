// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import EnableEncryptionModal from '../EnableEncryptionModal.jsx';

vi.mock('../../api.js', () => ({ post: vi.fn() }));
import { post } from '../../api.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function fillEntry(pass = 'longpassword', confirm = 'longpassword') {
  fireEvent.change(screen.getByLabelText(/^Passphrase$/i), { target: { value: pass } });
  fireEvent.change(screen.getByLabelText(/Confirm passphrase/i), { target: { value: confirm } });
}

describe('EnableEncryptionModal', () => {
  it('rejects a too-short passphrase before calling the API', async () => {
    render(<EnableEncryptionModal projectId="p1" onClose={() => {}} />);
    fillEntry('short', 'short');
    fireEvent.click(screen.getByRole('button', { name: /enable encryption/i }));
    await waitFor(() => expect(screen.getByText(/at least 12 characters/i)).toBeTruthy());
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects mismatched passphrases', async () => {
    render(<EnableEncryptionModal projectId="p1" onClose={() => {}} />);
    fillEntry('longpassword', 'different1234');
    fireEvent.click(screen.getByRole('button', { name: /enable encryption/i }));
    await waitFor(() => expect(screen.getByText(/do not match/i)).toBeTruthy());
    expect(post).not.toHaveBeenCalled();
  });

  it('reveals the recovery code and gates Done on the saved-checkbox', async () => {
    post.mockResolvedValueOnce({ ok: true, json: async () => ({ recoveryCode: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789' }) });
    const onEnabled = vi.fn();
    const onClose = vi.fn();
    render(<EnableEncryptionModal projectId="p1" onClose={onClose} onEnabled={onEnabled} />);

    fillEntry();
    fireEvent.click(screen.getByRole('button', { name: /enable encryption/i }));

    await waitFor(() => expect(screen.getByText(/ABCD-EFGH-JKMN/)).toBeTruthy());

    const done = screen.getByRole('button', { name: /done/i });
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(done.disabled).toBe(false);

    fireEvent.click(done);
    expect(onEnabled).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a server error from /encrypt', async () => {
    post.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Project is already encrypted' }) });
    render(<EnableEncryptionModal projectId="p1" onClose={() => {}} />);
    fillEntry();
    fireEvent.click(screen.getByRole('button', { name: /enable encryption/i }));
    await waitFor(() => expect(screen.getByText(/already encrypted/i)).toBeTruthy());
  });

  it('posts passphrase + hint to /encrypt', async () => {
    post.mockResolvedValueOnce({ ok: true, json: async () => ({ recoveryCode: 'X' }) });
    render(<EnableEncryptionModal projectId="p7" onClose={() => {}} />);
    fillEntry();
    fireEvent.change(screen.getByLabelText(/Hint/i), { target: { value: 'the usual' } });
    fireEvent.click(screen.getByRole('button', { name: /enable encryption/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/projects/p7/encrypt', {
      passphrase: 'longpassword',
      passphraseHint: 'the usual',
    }));
  });
});
