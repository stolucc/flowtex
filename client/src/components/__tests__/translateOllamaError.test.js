// Pin the Ollama-error → user-message translation. Each case below
// matches a raw Go error string the helper actually emits when its
// outbound probe of Ollama fails — sourced from the user-visible
// errors we've seen in practice plus a few defensive synonyms.

import { describe, it, expect } from 'vitest';
import { translateOllamaError } from '../LlmActionDialog.jsx';

describe('translateOllamaError', () => {
  it('falls back to a friendly message on empty error', () => {
    expect(translateOllamaError('')).toMatch(/No local LLM detected/);
    expect(translateOllamaError(null)).toMatch(/No local LLM detected/);
    expect(translateOllamaError(undefined)).toMatch(/No local LLM detected/);
  });

  it('recognises connection-refused and tells the user to start Ollama', () => {
    const cases = [
      'Get "http://127.0.0.1:11434/api/tags": dial tcp 127.0.0.1:11434: connect: connection refused',
      'connection refused',
      // Windows phrasing
      'No connection could be made because the target machine actively refused it.',
    ];
    for (const c of cases) {
      const out = translateOllamaError(c);
      expect(out).toMatch(/Ollama is not running/i);
      expect(out).toMatch(/ollama serve|Ollama app/);
    }
  });

  it('recognises DNS resolution failures and points at the config', () => {
    const out = translateOllamaError('lookup my-ollama: no such host');
    expect(out).toMatch(/doesn'?t resolve/i);
    expect(out).toMatch(/llm_base_url/);
  });

  it('recognises timeout / deadline exceeded as "Ollama is busy"', () => {
    expect(translateOllamaError('context deadline exceeded')).toMatch(/didn'?t respond in time/i);
    expect(translateOllamaError('net/http: TLS handshake timeout')).toMatch(/didn'?t respond in time/i);
  });

  it('surfaces Ollama HTTP errors as-is, prefaced', () => {
    expect(translateOllamaError('ollama returned 500: internal error'))
      .toMatch(/HTTP error/);
  });

  it('falls through for unknown errors but doesn\'t hide them', () => {
    const out = translateOllamaError('something weird happened (xyz)');
    expect(out).toMatch(/Couldn'?t reach the local LLM/i);
    expect(out).toContain('something weird happened (xyz)');
  });
});
