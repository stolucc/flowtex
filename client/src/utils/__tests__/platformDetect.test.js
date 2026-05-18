import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { detectPlatform, helperAssetName, helperDownloadURL } from '../platformDetect.js';

// Each case mutates navigator.platform / userAgent — restore afterwards.
const ORIG_PLATFORM = navigator.platform;
const ORIG_UA = navigator.userAgent;
function setNav({ platform, userAgent }) {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}
afterEach(() => {
  setNav({ platform: ORIG_PLATFORM, userAgent: ORIG_UA });
});

describe('detectPlatform', () => {
  it('reads macOS from platform string', () => {
    setNav({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120' });
    const p = detectPlatform();
    expect(p.os).toBe('darwin');
    // We currently default to arm64 on Apple platform — the alternative
    // (intel) is the rare case in 2026+ and we offer the explicit list
    // in the UI either way.
    expect(p.arch).toBe('arm64');
  });

  it('reads Linux from platform string', () => {
    setNav({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120' });
    expect(detectPlatform()).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('reads Windows', () => {
    setNav({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' });
    expect(detectPlatform()).toEqual({ os: 'windows' });
  });

  it('falls back to unknown for obscure UAs', () => {
    setNav({ platform: 'NetBSD', userAgent: 'curl/7.0' });
    expect(detectPlatform()).toEqual({ os: 'unknown' });
  });
});

describe('helperAssetName + helperDownloadURL', () => {
  it('returns the right binary name for each supported platform', () => {
    expect(helperAssetName({ os: 'darwin', arch: 'arm64' })).toBe('flowtex-helper-darwin-arm64');
    expect(helperAssetName({ os: 'darwin', arch: 'amd64' })).toBe('flowtex-helper-darwin-amd64');
    expect(helperAssetName({ os: 'linux', arch: 'amd64' })).toBe('flowtex-helper-linux-amd64');
  });

  it('returns null for unsupported platforms (windows, unknown)', () => {
    expect(helperAssetName({ os: 'windows' })).toBeNull();
    expect(helperAssetName({ os: 'unknown' })).toBeNull();
  });

  it('builds the GitHub Releases download URL for a supported platform', () => {
    const url = helperDownloadURL({ os: 'darwin', arch: 'arm64' });
    expect(url).toMatch(/github\.com.*releases\/latest\/download\/flowtex-helper-darwin-arm64$/);
  });

  it('returns null URL when the asset is not available', () => {
    expect(helperDownloadURL({ os: 'windows' })).toBeNull();
  });
});
