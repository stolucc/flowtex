import db from '../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export { UUID_RE };

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

export async function requireProjectAccess(req, res, next) {
  const projectId = req.params.id || req.params.projectId;
  if (!projectId) return next();
  if (!UUID_RE.test(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }

  const member = await db.get(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, req.session.userId]
  );

  if (!member) {
    return res.status(403).json({ error: 'No access to this project' });
  }

  req.projectRole = member.role;
  next();
}

export async function requireAdmin(req, res, next) {
  const user = await db.get('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
  if (!user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export async function isProjectMember(projectId, userId) {
  if (!UUID_RE.test(projectId)) return null;
  const row = await db.get(
    'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return row || null;
}
