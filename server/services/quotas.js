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
// Each cap is admin-tunable from the dashboard — a row in `settings`
// keyed `quota_<name>` overrides the default below. Asserts read the
// live value via getEffectiveQuota on every call, so a change takes
// effect immediately without a server restart.
//
// SCOPE NOTE (audit F5 / 2026-06-04): BLOB_BYTES_PER_USER covers
// binary content only — text in files.content is per-file-bounded
// by createFile / updateFileContent's 10 MB cap, multiplied by the
// FILES_PER_PROJECT and PROJECTS_PER_USER caps. So total worst-case
// per-user text storage is independent of (and not visible in) the
// blob quota. For a realistic deployment the text cap is rarely the
// constraint; for an admin who wants total-storage visibility the
// fix is host-level monitoring (du / pg_total_relation_size), not a
// new per-user quota.

import db from '../db.js';

export const QUOTAS = {
  // How many projects a single user can OWN. Memberships in projects
  // owned by others do not count.
  PROJECTS_PER_USER: 1000,

  // Files in a single project. Catches "5000-fake-PNGs" stress patterns
  // before they fill the file tree.
  FILES_PER_PROJECT: 2000,

  // Total bytes of binary content across every project this user owns.
  // Counted as the SUM of project_blobs.size for blobs referenced by
  // files in this user's owned projects.
  BLOB_BYTES_PER_USER: 2 * 1024 * 1024 * 1024, // 2 GiB
};

// `settings.key` for each quota override. Admin UI writes these via
// PUT /api/admin/settings; reads come back through getEffectiveQuota.
export const QUOTA_KEYS = {
  PROJECTS_PER_USER: 'quota_projects_per_user',
  FILES_PER_PROJECT: 'quota_files_per_project',
  BLOB_BYTES_PER_USER: 'quota_blob_bytes_per_user',
};

/** Resolve the live value of one quota: admin-set override if present
 *  and parseable, else the static default. */
export async function getEffectiveQuota(name) {
  const fallback = QUOTAS[name];
  const key = QUOTA_KEYS[name];
  if (!key || fallback === undefined) {
    throw new Error(`Unknown quota name: ${name}`);
  }
  const row = await db.get('SELECT value FROM settings WHERE key = $1', [key]);
  if (!row?.value) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Advisory-lock namespace. pg_advisory_xact_lock takes two int4s; we use
// a fixed first int to namespace the quota locks away from any other
// advisory lock the application might use, and hashtext(...) as the
// second int to derive a per-user / per-project bucket.
const LOCK_NAMESPACE = 0x510a;

/** Throw a 413-tagged Error when the user already owns this many projects.
 *  Takes `tx` so the SELECT runs against the same snapshot as the
 *  subsequent INSERT. Grabs a per-user xact-advisory lock first, which
 *  serialises concurrent createProject calls from the same user and
 *  closes the "two parallel creates both pass the cap" race. */
export async function assertProjectCountUnderLimit(tx, userId) {
  await tx.run(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [LOCK_NAMESPACE, `user:${userId}`]);
  const limit = await getEffectiveQuota('PROJECTS_PER_USER');
  const row = await tx.get(
    `SELECT COUNT(*)::int AS n
       FROM project_members
      WHERE user_id = $1 AND role = 'owner'`,
    [userId],
  );
  if ((row?.n ?? 0) >= limit) {
    const err = new Error(
      `Project limit reached (${limit}). Delete an existing project before creating a new one.`,
    );
    err.status = 413;
    throw err;
  }
}

/** Throw when the project already holds this many files.
 *  Called inside the same transaction as the INSERT for accuracy.
 *  Per-project advisory lock serialises concurrent writers on this
 *  project so the cap is strict, not eventual. */
export async function assertFileCountUnderLimit(tx, projectId, extraFiles = 1) {
  await tx.run(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [LOCK_NAMESPACE, `project:${projectId}`]);
  const limit = await getEffectiveQuota('FILES_PER_PROJECT');
  const row = await tx.get(
    'SELECT COUNT(*)::int AS n FROM files WHERE project_id = $1',
    [projectId],
  );
  if ((row?.n ?? 0) + extraFiles > limit) {
    const err = new Error(
      `File limit reached for this project (${limit}). Delete files before adding more.`,
    );
    err.status = 413;
    throw err;
  }
}

/** Throw when adding `extraBytes` bytes would put the project's OWNER
 *  over their total-blob-bytes quota. Looks up the owner internally so
 *  callers only need a projectId. Takes the same per-user advisory lock
 *  the project-count check uses, so parallel uploads from the same
 *  owner are serialised against the SUM. */
export async function assertBlobBytesUnderLimitForProject(tx, projectId, extraBytes) {
  if (extraBytes <= 0) return;
  const owner = await tx.get(
    `SELECT user_id FROM project_members WHERE project_id = $1 AND role = 'owner' LIMIT 1`,
    [projectId],
  );
  if (!owner) return; // orphan project — no owner to charge against
  await tx.run(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [LOCK_NAMESPACE, `user:${owner.user_id}`]);
  const limit = await getEffectiveQuota('BLOB_BYTES_PER_USER');
  const row = await tx.get(
    `SELECT COALESCE(SUM(pb.size), 0)::bigint AS used
       FROM project_members pm
       JOIN project_blobs pb ON pb.project_id = pm.project_id
      WHERE pm.user_id = $1 AND pm.role = 'owner'`,
    [owner.user_id],
  );
  const used = Number(row?.used ?? 0);
  if (used + extraBytes > limit) {
    const err = new Error(
      `Storage quota exceeded (${formatBytes(limit)}). ` +
      `Delete some figures or PDFs before uploading more.`,
    );
    err.status = 413;
    throw err;
  }
}

/** Return a usage snapshot for the given user. Used by /api/me/usage and
 *  by the admin overview. */
export async function getUserUsage(userId) {
  const [projectsLimit, filesLimit, blobLimit] = await Promise.all([
    getEffectiveQuota('PROJECTS_PER_USER'),
    getEffectiveQuota('FILES_PER_PROJECT'),
    getEffectiveQuota('BLOB_BYTES_PER_USER'),
  ]);
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
    projects: { used: projects?.n ?? 0, limit: projectsLimit },
    storageBytes: { used: Number(storage?.used ?? 0), limit: blobLimit },
    filesPerProjectLimit: filesLimit,
  };
}

function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
