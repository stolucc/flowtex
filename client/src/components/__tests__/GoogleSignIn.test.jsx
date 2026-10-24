// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../api.js', () => ({ post: vi.fn(), get: vi.fn() }));
import { post, get } from '../../api.js';
import {
  GoogleSignInButton,
  GoogleLinkInterstitial,
  GoogleMfaInterstitial,
  GoogleAccountSection,
  googleErrorMessage,
} from '../GoogleSignIn.jsx';

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

let assign;
beforeEach(() => {
  vi.clearAllMocks();
  assign = vi.fn();
  // happy-dom's location.assign would navigate; capture instead.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname: '/', search: '', assign },
  });
});
afterEach(cleanup);

describe('googleErrorMessage', () => {
  it('maps known codes and falls back for unknown ones', () => {
    expect(googleErrorMessage(null)).toBe('');
    expect(googleErrorMessage('cancelled')).toMatch(/cancelled/);
    expect(googleErrorMessage('sso_required')).toMatch(/organisation/);
    expect(googleErrorMessage('<script>')).toBe('Google sign-in failed. Please try again.');
  });
});

describe('GoogleSignInButton', () => {
  it('links to the server login route carrying the deep link as returnTo', () => {
    window.location.pathname = '/project/abc';
    window.location.search = '?file=main.tex&google_error=x';
    render(<GoogleSignInButton />);
    const a = screen.getByRole('link', { name: /continue with google/i });
    expect(a.getAttribute('href')).toBe(
      `/api/auth/google/login?returnTo=${encodeURIComponent('/project/abc?file=main.tex')}`,
    );
  });

  it('uses / as returnTo from a /login page', () => {
    window.location.pathname = '/login/link-google';
    render(<GoogleSignInButton label="Sign up with Google" />);
    expect(screen.getByRole('link', { name: /sign up with google/i }).getAttribute('href'))
      .toBe('/api/auth/google/login?returnTo=%2F');
  });
});

describe('GoogleLinkInterstitial', () => {
  it('shows the expired state when nothing is pending', async () => {
    get.mockResolvedValueOnce(json({}, false, 404));
    render(<GoogleLinkInterstitial />);
    await waitFor(() => expect(screen.getByText(/expired or was already used/i)).toBeTruthy());
  });

  it('asks for the password, then the 2FA code, then follows the redirect', async () => {
    get.mockResolvedValueOnce(json({ kind: 'link', email: 'u@example.com', existingName: 'U', totpEnabled: true }));
    render(<GoogleLinkInterstitial />);
    await waitFor(() => expect(screen.getByText('u@example.com')).toBeTruthy());

    post.mockResolvedValueOnce(json({ mfaRequired: true }));
    fireEvent.change(screen.getByLabelText('FlowTex password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /link and sign in/i }));
    await waitFor(() => expect(screen.getByLabelText('2FA code')).toBeTruthy());
    expect(post).toHaveBeenLastCalledWith('/api/auth/google/confirm-link', { password: 'pw' });

    post.mockResolvedValueOnce(json({ ok: true, redirect: '/project/abc' }));
    fireEvent.change(screen.getByLabelText('2FA code'), { target: { value: '12a3456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify and link/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/project/abc'));
    expect(post).toHaveBeenLastCalledWith('/api/auth/google/confirm-link', { password: 'pw', totpCode: '123456', trustDevice: true });
  });

  it('shows the server error on a wrong password', async () => {
    get.mockResolvedValueOnce(json({ kind: 'link', email: 'u@example.com', existingName: '' }));
    render(<GoogleLinkInterstitial />);
    await waitFor(() => screen.getByLabelText('FlowTex password'));
    post.mockResolvedValueOnce(json({ error: 'Incorrect password' }, false, 401));
    fireEvent.change(screen.getByLabelText('FlowTex password'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /link and sign in/i }));
    await waitFor(() => expect(screen.getByText('Incorrect password')).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });

  it('cancel clears server state and returns to /login', async () => {
    get.mockResolvedValueOnce(json({ kind: 'link', email: 'u@example.com' }));
    post.mockResolvedValueOnce(json({ ok: true }));
    render(<GoogleLinkInterstitial />);
    await waitFor(() => screen.getByRole('button', { name: /cancel/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(post).toHaveBeenCalledWith('/api/auth/google/cancel', {});
  });
});

describe('GoogleMfaInterstitial', () => {
  it('posts the code and follows the redirect', async () => {
    post.mockResolvedValueOnce(json({ ok: true, redirect: '/p' }));
    render(<GoogleMfaInterstitial />);
    fireEvent.change(screen.getByLabelText('2FA code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/p'));
    expect(post).toHaveBeenCalledWith('/api/auth/google/mfa', { totpCode: '654321', trustDevice: true });
  });

  it('keeps the user on the page with the error on a bad code', async () => {
    post.mockResolvedValueOnce(json({ error: 'Invalid 2FA code' }, false, 401));
    render(<GoogleMfaInterstitial />);
    fireEvent.change(screen.getByLabelText('2FA code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));
    await waitFor(() => expect(screen.getByText('Invalid 2FA code')).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('GoogleAccountSection', () => {
  const user = (over) => ({ id: 'u1', googleLinked: false, hasPassword: true, ...over });

  it('says so when Google sign-in is not enabled', async () => {
    get.mockResolvedValueOnce(json({ available: false }));
    render(<GoogleAccountSection user={user()} onUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/not enabled on this server/i)).toBeTruthy());
  });

  it('link: confirms password then navigates to the Google URL', async () => {
    get.mockResolvedValueOnce(json({ available: true }));
    post.mockResolvedValueOnce(json({ url: 'https://accounts.google.com/x' }));
    render(<GoogleAccountSection user={user()} onUpdate={() => {}} />);
    await waitFor(() => screen.getByLabelText('Current password'));
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /link google account/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/x'));
    expect(post).toHaveBeenCalledWith('/api/auth/google/link-start', { password: 'pw' });
  });

  it('unlink: requires password and updates the user', async () => {
    get.mockResolvedValueOnce(json({ available: true }));
    post.mockResolvedValueOnce(json({ ok: true }));
    const onUpdate = vi.fn();
    render(<GoogleAccountSection user={user({ googleLinked: true })} onUpdate={onUpdate} />);
    await waitFor(() => screen.getByLabelText('Current password'));
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /unlink google/i }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ googleLinked: false })));
    expect(post).toHaveBeenCalledWith('/api/auth/google/unlink', { password: 'pw' });
  });

  it('Google-only account: no unlink form, explains how to set a password', async () => {
    get.mockResolvedValueOnce(json({ available: true }));
    render(<GoogleAccountSection user={user({ googleLinked: true, hasPassword: false })} onUpdate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no password yet/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /unlink/i })).toBeNull();
  });

  it('shows the result of a link round-trip and strips the param', async () => {
    window.location.search = '?google=linked';
    const replace = vi.spyOn(window.history, 'replaceState');
    get.mockResolvedValueOnce(json({ available: true }));
    const onUpdate = vi.fn();
    render(<GoogleAccountSection user={user()} onUpdate={onUpdate} />);
    await waitFor(() => expect(screen.getByText(/google account linked/i)).toBeTruthy());
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ googleLinked: true }));
    expect(replace).toHaveBeenCalledWith({}, '', '/');
  });
});
