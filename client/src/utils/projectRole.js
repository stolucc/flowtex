/**
 * Decide whether the current user's project membership should make the
 * file editor read-only. Owners and editors can modify files; viewers
 * and commenters can read + (in the commenter case) post comments via
 * the comment sidebar, but cannot type into the file content.
 *
 * Server enforces the same posture via `checkEditor` / writeTypes /
 * `isAllowedWriteRole`; this is purely for client UX so the editor
 * stops accepting input that would silently fail on save.
 *
 * Returns false (editable) when membership hasn't loaded yet, so the
 * editor isn't briefly locked while the project page mounts. The
 * server-side gate is the actual security control; this is the
 * "don't let the user type into the void" affordance.
 *
 * @param {Array<{id: string, role: string}>} members
 * @param {string|undefined|null} userId
 * @returns {boolean} true if the editor should be read-only.
 */
export function isReadOnlyForUser(members, userId) {
  if (!Array.isArray(members) || !userId) return false;
  const me = members.find((m) => m.id === userId);
  if (!me) return false;
  return me.role !== 'editor' && me.role !== 'owner';
}
