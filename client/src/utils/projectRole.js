// @ts-check
/**
 * Look up the current user's project role from a members list. Returns
 * null when membership hasn't loaded yet, when there's no logged-in
 * user, or when the user isn't in the list.
 *
 * @param {Array<{id: string, role: string}>} members
 * @param {string|undefined|null} userId
 * @returns {string|null} the role string ('owner' | 'editor' | 'commenter' | 'viewer') or null.
 */
export function getProjectRole(members, userId) {
  if (!Array.isArray(members) || !userId) return null;
  const me = members.find((m) => m.id === userId);
  return me ? me.role : null;
}

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
  const role = getProjectRole(members, userId);
  // null means membership not loaded or user not in list -- stay
  // editable (server is the gate; better to not lock an owner out
  // during page load). Any non-null role that isn't editor/owner
  // (including '' / 'commenter' / 'viewer' / an unknown future
  // role) is treated as read-only.
  if (role == null) return false;
  return role !== 'editor' && role !== 'owner';
}
