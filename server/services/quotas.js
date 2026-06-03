// Static per-user resource caps. Bounds the blast radius of a single
// misbehaving (or compromised) account on a small VPS deployment.
//
// All limits are intentionally generous for legitimate use — a thesis
// project sits comfortably inside every cap. They exist to stop
// scripted abuse (creating thousands of projects, packing 5000-byte
// PNGs to fill the disk, etc.), not to gate normal workflows.
//
// Caps apply to the project OWNER:
//   - Project count: counted across rows where the user holds 'owner'
//     in project_members.
//   - Storage and file count: collaborators' uploads count against
//     whichever owner owns the project they uploaded into.
//
// Static caps for now; per-user overrides can be layered on later via
// a users.quota_override JSON column without changing call sites.

import db from '../db.js';

export const QUOTAS = {
  // How many projects a single user can OWN. Memberships in projects
  // owned by others do not count.
  PROJECTS_PER_USER: 100,

  // Files in a single project. Catches "5000-fake-PNGs" stress patterns
  // before they fill the file tree.
  FILES_PER_PROJECT: 2000,

  // Total bytes of binary content across every project this user owns.
  // Counted as the SUM of project_blobs.size for blobs referenced by
  // files in this user's owned projects.
  BLOB_BYTES_PER_USER: 2 * 1024 * 1024 * 1024, // 2 GiB
};

/** Throw a 413-tagged Error when the user already owns this many projects. */
export async function assertProjectCountUnderLimit(userId) {
  const row = await db.get(
    `SELECT COUNT(*)::int AS n
       FROM project_members
      WHERE user_id = $1 AND role = 'owner'`,
    [userId],
  );
  if ((row?.n ?? 0) >= QUOTAS.PROJECTS_PER_USER) {
    const err = new Error(
      `Project limit reached (${QUOTAS.PROJECTS_PER_USER}). Delete an existing project before creating a new one.`,
    );
    err.status = 413;
    throw err;
  }
}

/** Throw when the project already holds this many files.
 *  Called inside the same transaction as the INSERT for accuracy. */
export async function assertFileCountUnderLimit(tx, projectId, extraFiles = 1) {
  const row = await tx.get(
    'SELECT COUNT(*)::int AS n FROM files WHERE project_id = $1',
    [projectId],
  );
  if ((row?.n ?? 0) + extraFiles > QUOTAS.FILES_PER_PROJECT) {
    const err = new Error(
      `File limit reached for this project (${QUOTAS.FILES_PER_PROJECT}). Delete files before adding more.`,
    );
    err.status = 413;
    throw err;
  }
}

/** Throw when adding `extraBytes` bytes would put the project's OWNER
 *  over their total-blob-bytes quota. Looks up the owner internally so
 *  callers only need a projectId. */
export async function assertBlobBytesUnderLimitForProject(projectId, extraBytes) {
  if (extraBytes <= 0) return;
  const owner = await db.get(
    `SELECT user_id FROM project_members WHERE project_id = $1 AND role = 'owner' LIMIT 1`,
    [projectId],
  );
  if (!owner) return; // orphan project — no owner to charge against
  const row = await db.get(
    `SELECT COALESCE(SUM(pb.size), 0)::bigint AS used
       FROM project_members pm
       JOIN project_blobs pb ON pb.project_id = pm.project_id
      WHERE pm.user_id = $1 AND pm.role = 'owner'`,
    [owner.user_id],
  );
  const used = Number(row?.used ?? 0);
  if (used + extraBytes > QUOTAS.BLOB_BYTES_PER_USER) {
    const err = new Error(
      `Storage quota exceeded (${formatBytes(QUOTAS.BLOB_BYTES_PER_USER)}). ` +
      `Delete some figures or PDFs before uploading more.`,
    );
    err.status = 413;
    throw err;
  }
}

/** Return a usage snapshot for the given user. Used by /api/me/usage and
 *  by the admin overview. */
export async function getUserUsage(userId) {
  const projects = await db.get(
    `SELECT COUNT(*)::int AS n
       FROM project_members
      WHERE user_id = $1 AND role = 'owner'`,
    [userId],
  );
  const storage = await db.get(
    `SELECT COALESCE(SUM(pb.size), 0)::bigint AS used
       FROM project_members pm
       JOIN project_blobs pb ON pb.project_id = pm.project_id
      WHERE pm.user_id = $1 AND pm.role = 'owner'`,
    [userId],
  );
  return {
    projects: { used: projects?.n ?? 0, limit: QUOTAS.PROJECTS_PER_USER },
    storageBytes: { used: Number(storage?.used ?? 0), limit: QUOTAS.BLOB_BYTES_PER_USER },
    filesPerProjectLimit: QUOTAS.FILES_PER_PROJECT,
  };
}

function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
