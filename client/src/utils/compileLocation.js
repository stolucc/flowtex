// @ts-check
// Resolves where a compile should actually run, given the per-user default,
// the per-project override, and the live helper status. See
// LOCAL_COMPILE_DESIGN.md §5 for the original truth table.
//
// Two return-shape fields convey what happened:
//   - `fallbackReason` (only when source = 'server'): the user *wanted*
//     local but we could not honour it. Surface to the user via the
//     banner — they need to know their preference isnt taking effect.
//   - `noticeReason` (only when source = 'local'): we are running local
//     but there is something worth telling the user about (e.g. their
//     TeX Live year doesnt match the projects pinned distribution).
//     Surface as a softer notice so they understand why their PDF may
//     differ from a collaborators server-compiled one.
//
// Policy update (2026-05-17): version mismatch is now a *notice*, not a
// fallback. The user owns their TeX install and accepts the risk that
// PDFs may differ slightly across machines. The mismatch is made
// visible, not silently routed around.
//
// Invariants:
//   - Missing project / user / helperStatus → server, no-fallback (the
//     user has not asked for local).
//   - 'local' is only returned when the user explicitly opted in AND
//     the helper is reachable.
//
// Pure function: no side effects, no I/O.

/** @typedef {{ available: boolean, year?: string }} HelperStatus */

/**
 * @param {{ compile_location?: string|null, tex_distribution?: string|null }} project
 * @param {{ compileLocation?: string }} user
 * @param {HelperStatus} helperStatus
 * @returns {{ source: 'server'|'local', fallbackReason?: 'no_helper', noticeReason?: 'version_mismatch' }}
 */
export function resolveCompileLocation(project, user, helperStatus) {
  const wanted = project?.compile_location || user?.compileLocation || 'server';
  if (wanted === 'server') return { source: 'server' };
  if (!helperStatus || !helperStatus.available) {
    return { source: 'server', fallbackReason: 'no_helper' };
  }
  // Version mismatch is a soft notice, not a fallback — the user opted
  // into local explicitly, so we honour that and just flag the mismatch.
  if (project?.tex_distribution && helperStatus.year && helperStatus.year !== project.tex_distribution) {
    return { source: 'local', noticeReason: 'version_mismatch' };
  }
  return { source: 'local' };
}

/** Human-friendly text for the compile-button tooltip / settings hint.
 *  @param {any} choice
 *  @param {any} project
 *  @param {any} user
 *  @param {any} helperStatus
 */
export function describeChoice(choice, project, user, helperStatus) {
  if (choice.source === 'local') {
    if (choice.noticeReason === 'version_mismatch') {
      return `Compiling locally on TeX Live ${helperStatus?.year}; project pins ${project?.tex_distribution} — output may differ from a server compile.`;
    }
    return `Local helper detected (TeX Live ${helperStatus?.year || '?'}); compiling on your machine.`;
  }
  if (choice.fallbackReason === 'no_helper') {
    return `Local helper not detected — compiling on the FlowTex server.`;
  }
  // No opt-in at all.
  return 'Compiling on the FlowTex server.';
}
