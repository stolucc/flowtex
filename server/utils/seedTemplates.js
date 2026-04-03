import { v4 as uuid } from 'uuid';
import db from '../db.js';
import TEMPLATES from './templates.js';

/**
 * Seed preloaded templates into the user_templates table on startup.
 * Only inserts templates that don't already exist (by id).
 * Also assigns default tags based on category.
 */
export default async function seedPreloadedTemplates() {
  for (const tmpl of TEMPLATES) {
    const exists = await db.get('SELECT id FROM user_templates WHERE id = $1', [tmpl.id]);
    if (exists) continue;

    await db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO user_templates (id, name, description, category, created_by, preloaded) VALUES ($1, $2, $3, $4, NULL, TRUE)',
        [tmpl.id, tmpl.name, tmpl.description, tmpl.category],
      );

      for (const file of tmpl.files) {
        await tx.run(
          'INSERT INTO user_template_files (id, template_id, path, content, is_binary) VALUES ($1, $2, $3, $4, FALSE)',
          [uuid(), tmpl.id, file.path, file.content],
        );
      }

      // Assign default tag based on category
      const tag = await tx.get('SELECT id FROM template_tags WHERE name = $1', [tmpl.category]);
      if (tag) {
        await tx.run(
          'INSERT INTO template_tag_map (template_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [tmpl.id, tag.id],
        );
      }
    });
  }
}
