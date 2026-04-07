import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';

const router = Router();

// Validate CSS color: hex (#rgb, #rrggbb, #rrggbbaa) or named colors only
const COLOR_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
function validColor(c) {
  return typeof c === 'string' && COLOR_RE.test(c);
}

/** GET /api/tags -- List all tags belonging to the current user. */
router.get('/', async (req, res) => {
  const tags = await db.all('SELECT * FROM tags WHERE user_id = $1 ORDER BY name', [req.session.userId]);
  res.json(tags);
});

/** POST /api/tags -- Create a new tag with a name and optional color. */
router.post('/', async (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  if (name.length > 100) return res.status(400).json({ error: 'Tag name too long' });
  const id = uuid();
  try {
    const safeColor = validColor(color) ? color : '#89b4fa';
    await db.run('INSERT INTO tags (id, user_id, name, color) VALUES ($1, $2, $3, $4)', [
      id,
      req.session.userId,
      name.trim(),
      safeColor,
    ]);
    res.json({ id, name: name.trim(), color: safeColor });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Tag already exists' });
    throw e;
  }
});

/** PATCH /api/tags/:id -- Update a tag's name and/or color. */
router.patch('/:id', async (req, res) => {
  const { name, color } = req.body;
  const tag = await db.get('SELECT * FROM tags WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });
  if (name !== undefined) await db.run('UPDATE tags SET name = $1 WHERE id = $2', [name.trim(), req.params.id]);
  if (color !== undefined && validColor(color))
    await db.run('UPDATE tags SET color = $1 WHERE id = $2', [color, req.params.id]);
  res.json({ ok: true });
});

/** DELETE /api/tags/:id -- Delete a tag. */
router.delete('/:id', async (req, res) => {
  await db.run('DELETE FROM tags WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  res.json({ ok: true });
});

export default router;
