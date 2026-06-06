// Allowlist gate for URLs that originate from untrusted project content
// (e.g. the URL argument of \href{URL}{text} in a collaborator-authored
// .tex file). Used before window.open / element.href assignments to
// block javascript:, data:, vbscript:, file: and other non-web schemes
// from reaching the browser navigation surface.

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns true iff `raw` is safe to hand to window.open or to assign as
 * a link's href when the value comes from untrusted project content.
 *
 * Accepts:
 *   - absolute http(s) and mailto URLs
 *   - same-origin relatives (start with /, ?, #)
 *
 * Rejects:
 *   - javascript:, data:, vbscript:, file: and any other scheme
 *   - protocol-relative URLs (//host/...) — uncommon in LaTeX and would
 *     bypass scheme inspection if we accepted them blind
 *   - empty / whitespace / non-string / unparseable input
 */
export function isSafeWebUrl(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('?') || trimmed.startsWith('#')) return true;
  let url;
  try { url = new URL(trimmed); } catch { return false; }
  return SAFE_SCHEMES.has(url.protocol);
}
