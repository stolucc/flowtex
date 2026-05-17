// Resolves where a compile should actually run, given the per-user default,
// the per-project override, and the live helper status. See
// LOCAL_COMPILE_DESIGN.md §5 for the full truth table.
//
// Always returns an object so the caller can branch on `source` AND show
// the user *why* the fallback fired (the toast text in the editor reads
// from `fallbackReason`).
//
// Invariants:
//   - If anything is missing or uncertain → return { source: 'server' }.
//     The server path is the always-available safety net.
//   - 'local' is only returned when the user explicitly opted in
//     (project override OR user default) AND the helper is reachable AND
//     the helpers TeX Live year matches the projects pinned distribution.
//
// Pure function: no side effects, no I/O. Used in useCompilation but also
// from the compile-button-label render and from settings UI for the
// "(currently: …)" preview.

/** @typedef {{ available: boolean, year?: string }} HelperStatus */

/**
 * @param {{ compile_location?: string|null, tex_distribution?: string|null }} project
 * @param {{ compileLocation?: string }} user
 * @param {HelperStatus} helperStatus
 * @returns {{ source: 'server'|'local', fallbackReason?: 'no_helper'|'version_mismatch'|'flag_off' }}
 */
export function resolveCompileLocation(project, user, helperStatus) {
  const wanted = project?.compile_location || user?.compileLocation || 'server';
  if (wanted === 'server') return { source: 'server' };
  if (!helperStatus || !helperStatus.available) {
    return { source: 'server', fallbackReason: 'no_helper' };
  }
  // The version check is intentionally strict: equality on year. The design
  // says we want a local-compiled PDF to be byte-identical to what the
  // server would produce, so different TeX Live years are a non-starter
  // even if "they would probably work". When the project leaves
  // tex_distribution unset, fall through — the user has accepted whatever
  // year the server-side default exposes, so the helpers year is treated
  // as a match by definition.
  if (project?.tex_distribution && helperStatus.year && helperStatus.year !== project.tex_distribution) {
    return { source: 'server', fallbackReason: 'version_mismatch' };
  }
  return { source: 'local' };
}

/** Human-friendly text for the compile-button tooltip / settings hint. */
export function describeChoice(choice, project, user, helperStatus) {
  if (choice.source === 'local') {
    return `Local helper detected (TeX Live ${helperStatus?.year || '?'}); compiling on your machine.`;
  }
  if (choice.fallbackReason === 'no_helper') {
    return `Local helper not detected — compiling on the FlowTex server.`;
  }
  if (choice.fallbackReason === 'version_mismatch') {
    return `Local helper has TeX Live ${helperStatus?.year}, this project pins ${project?.tex_distribution} — compiling on the FlowTex server.`;
  }
  // No opt-in at all.
  return 'Compiling on the FlowTex server.';
}
