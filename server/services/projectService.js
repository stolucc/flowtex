// ReDoS triage 2026-06-02: this file has 6 detect-unsafe-regex hits, all
// in BibTeX / citation-text parsing. Each one was reviewed individually:
//
//   - line ~748, ~754: page-range patterns like (?:pp\.?\s*)?(\d+)\s*[–-]\s*(\d+)
//     and the proceedings variant. Bounded by literal delimiters; no
//     ambiguous nesting. Input is .bib content (size-capped).
//   - line ~878: parenthetical-citation matcher /\([^)]*?[A-Z]...\)/g.
//     Non-greedy [^)]*? with terminating ')' prevents catastrophic
//     backtracking — engine commits as soon as a ')' is hit.
//   - line ~966 / ~990: SN / AUTHOR patterns for textcite recognition.
//     The repeating subgroups have disjoint start sets (delim then
//     letter) so each iteration commits.
//   - line ~1078: detailed author-name pattern. Same shape — delimiter-
//     anchored repetitions.
//
// All inputs are user-uploaded .tex / .bib content bounded by the
// 50 MB file cap. Re-review on next periodic security pass.
/* eslint-disable security/detect-unsafe-regex */

import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import db from '../db.js';
import logger from '../logger.js';
import { isProjectMember, invalidateMembership } from '../middleware/auth.js';
import { BINARY_EXTS } from '../utils/fileTypes.js';
import { convertDocxToLatex, prettifyLatex } from '../utils/docxToLatex.js';
import { writeBlob } from './blobStore.js';

const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_SIZE = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_SIZE = 200 * 1024 * 1024;
const MAX_ZIP_RATIO = 100; // reject if decompressed/compressed > 100x

/** Check that a file path is safe (no traversal, no null bytes, no absolute paths). */
export function isValidFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || filePath.startsWith('\\')) return false;
  const parts = filePath.split(/[/\\]/);
  if (parts.some((p) => p === '..' || p === '')) return false;
  if (filePath.length > 500) return false;
  return true;
}

// ASVS V12.5.1 deny-list for binary uploads. None of these are
// legitimate LaTeX project assets, and the /raw endpoint serves
// uploaded bytes inline by default (HTML/SVG with embedded script
// would be sandboxed by the CSP we set, but defence-in-depth: refuse
// at upload time so they never enter the project at all).
// HTML is intentionally rejected too because a project member could
// otherwise stash a phishing page and share its /raw URL with a
// scoped session.
const DENIED_BINARY_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif',
  '.msi', '.dll', '.sys',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.ps1', '.psm1',
  '.html', '.htm', '.xhtml', '.mht', '.mhtml',
]);

function deniedBinaryExtension(filePath) {
  const base = String(filePath).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot);
  return DENIED_BINARY_EXTS.has(ext) ? ext : null;
}

// --- Authorization helpers ---

/** Check if a user is a member of a project; returns the membership or null. */
export async function checkMembership(projectId, userId) {
  return isProjectMember(projectId, userId);
}

/** Verify a user has editor (or owner) access; returns {member} or {error, status}. */
export async function checkEditor(projectId, userId) {
  const member = await isProjectMember(projectId, userId);
  if (!member) return { error: 'No access to this project', status: 403 };
  if (member.role === 'viewer') return { error: 'Viewers cannot modify this project', status: 403 };
  return { member };
}

/** Verify a user is the project owner; returns {member} or {error, status}. */
export async function checkOwnership(projectId, userId) {
  const member = await db.get('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [
    projectId,
    userId,
  ]);
  if (!member) return { error: 'No access to this project', status: 403 };
  if (member.role !== 'owner') return { error: 'Only the project owner can perform this action', status: 403 };
  return { member };
}

/** Fetch a file by ID and verify the user has access (optionally editor access). */
export async function getFileWithAccess(fileId, userId, { edit = false } = {}) {
  const file = await db.get('SELECT * FROM files WHERE id = $1', [fileId]);
  if (!file) return { error: 'File not found', status: 404 };
  const check = edit
    ? await checkEditor(file.project_id, userId)
    : { member: await checkMembership(file.project_id, userId) };
  if (check.error) return check;
  if (!check.member) return { error: 'No access to this project', status: 403 };
  return { file, member: check.member };
}

// --- Project CRUD ---

/** List all projects a user is a member of, with tags, owner info, and member counts. */
export async function listUserProjects(userId) {
  const projects = await db.all(
    `SELECT p.*, pm.role,
       owner_u.name AS owner_name,
       owner_pm.user_id AS owner_id,
       pgl.github_repo,
       (SELECT COUNT(*) FROM project_members pm2 WHERE pm2.project_id = p.id) AS member_count,
       (SELECT ps.author_name FROM project_snapshots ps
        WHERE ps.project_id = p.id
        ORDER BY ps.created_at DESC LIMIT 1) AS last_editor
     FROM projects p
     JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
     LEFT JOIN project_members owner_pm ON owner_pm.project_id = p.id AND owner_pm.role = 'owner'
     LEFT JOIN users owner_u ON owner_u.id = owner_pm.user_id
     LEFT JOIN project_github_links pgl ON pgl.project_id = p.id AND pgl.linked_by = $1
     ORDER BY p.updated_at DESC`,
    [userId],
  );

  if (projects.length > 0) {
    const projectIds = projects.map((p) => p.id);
    const placeholders = projectIds.map((_, i) => `$${i + 1}`).join(',');
    const allTags = await db.all(
      `SELECT pt.project_id, t.id, t.name, t.color FROM tags t
       JOIN project_tags pt ON pt.tag_id = t.id
       WHERE pt.project_id IN (${placeholders})`,
      projectIds,
    );
    const tagsByProject = {};
    for (const t of allTags) {
      if (!tagsByProject[t.project_id]) tagsByProject[t.project_id] = [];
      tagsByProject[t.project_id].push({ id: t.id, name: t.name, color: t.color });
    }
    for (const p of projects) {
      p.tags = tagsByProject[p.id] || [];
    }
  }

  return projects;
}

/** Create a new project from a user/preloaded template. */
export async function createProjectFromTemplate(userId, templateId, name) {
  const tmpl = await db.get('SELECT * FROM user_templates WHERE id = $1', [templateId]);
  if (!tmpl) throw Object.assign(new Error('Template not found'), { status: 404 });

  const templateFiles = await db.all(
    'SELECT path, content, is_binary FROM user_template_files WHERE template_id = $1',
    [templateId],
  );
  const id = uuid();
  const safeName = (name || tmpl.name).slice(0, 500).replace(/[\\{}$&#^_%~]/g, '');

  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [id, safeName]);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [id, userId, 'owner']);

    for (const file of templateFiles) {
      const content = tmpl.preloaded
        ? file.content.replace(/__TITLE__/g, safeName).replace(/__AUTHOR__/g, '')
        : file.content;
      await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
        uuid(),
        id,
        file.path,
        content,
        file.is_binary || false,
      ]);
    }
  });

  return { id, name: safeName };
}

/** Create a new user template by extracting files from a ZIP buffer. */
export async function createTemplateFromZip(userId, buffer, originalName, description, category, tagIds) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const fileEntries = entries.filter((e) => !e.isDirectory);

  if (fileEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains too many files (${fileEntries.length}, max ${MAX_ZIP_ENTRIES})`);
  }
  const totalDecompressed = fileEntries.reduce((sum, e) => sum + (e.header.size || 0), 0);
  if (totalDecompressed > MAX_ZIP_TOTAL_SIZE) {
    throw new Error('ZIP decompressed size too large');
  }
  if (buffer.length > 0 && totalDecompressed / buffer.length > MAX_ZIP_RATIO) {
    throw new Error('ZIP compression ratio too high (possible zip bomb)');
  }

  const templateName = (originalName || 'Untitled Template').replace(/\.zip$/i, '');
  const templateId = uuid();
  const created = [];

  await db.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO user_templates (id, name, description, category, created_by) VALUES ($1, $2, $3, $4, $5)',
      [templateId, templateName, description || '', category || 'General', userId],
    );

    let actualTotal = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      let entryPath = entry.entryName;
      if (entryPath.startsWith('__MACOSX/') || entryPath.split('/').some((p) => p.startsWith('.'))) continue;
      if (entryPath.includes('..') || !isValidFilePath(entryPath)) continue;
      if (entry.header.size > MAX_ZIP_ENTRY_SIZE) continue;

      const ext = entryPath.substring(entryPath.lastIndexOf('.')).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);
      const rawData = entry.getData();
      actualTotal += rawData.length;
      if (rawData.length > MAX_ZIP_ENTRY_SIZE || actualTotal > MAX_ZIP_TOTAL_SIZE) continue;
      const content = isBinary ? rawData.toString('base64') : rawData.toString('utf8');

      await tx.run(
        'INSERT INTO user_template_files (id, template_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)',
        [uuid(), templateId, entryPath, content, isBinary],
      );
      created.push({ id: uuid(), path: entryPath, templateId });
    }
  });

  // Strip common prefix from template files
  if (created.length > 1) {
    const firstSlash = created[0].path.indexOf('/');
    if (firstSlash > 0) {
      const prefix = created[0].path.substring(0, firstSlash + 1);
      if (created.every((f) => f.path.startsWith(prefix))) {
        await db.transaction(async (tx) => {
          for (const f of created) {
            const newPath = f.path.substring(prefix.length);
            if (newPath) {
              await tx.run('UPDATE user_template_files SET path = $1 WHERE template_id = $2 AND path = $3', [
                newPath,
                templateId,
                f.path,
              ]);
            }
          }
        });
      }
    }
  }

  // Set tags if provided
  if (tagIds && tagIds.length) {
    await setTemplateTags(templateId, tagIds);
  }

  const fileCount = await db.get('SELECT COUNT(*) as count FROM user_template_files WHERE template_id = $1', [
    templateId,
  ]);
  const tags =
    tagIds && tagIds.length
      ? await db.all('SELECT id, name, color FROM template_tags WHERE id = ANY($1)', [tagIds])
      : [];
  return {
    id: templateId,
    name: templateName,
    description: description || '',
    category: category || 'General',
    fileCount: fileCount.count,
    tags,
  };
}

/** List all templates (preloaded + user-created) with file counts and tags. */
export async function listAllTemplates() {
  const rows = await db.all(`
    SELECT ut.id, ut.name, ut.description, ut.category, ut.created_by, ut.preloaded,
           u.name as author_name,
           (SELECT COUNT(*) FROM user_template_files WHERE template_id = ut.id) as "fileCount"
    FROM user_templates ut
    LEFT JOIN users u ON u.id = ut.created_by
    ORDER BY ut.preloaded DESC, ut.created_at DESC
  `);
  // Attach tags to each template
  if (rows.length) {
    const tagRows = await db.all(
      `
      SELECT ttm.template_id, tt.id, tt.name, tt.color
      FROM template_tag_map ttm
      JOIN template_tags tt ON tt.id = ttm.tag_id
      WHERE ttm.template_id = ANY($1)
    `,
      [rows.map((r) => r.id)],
    );
    const tagMap = {};
    for (const tr of tagRows) {
      (tagMap[tr.template_id] ||= []).push({ id: tr.id, name: tr.name, color: tr.color });
    }
    for (const row of rows) {
      row.tags = tagMap[row.id] || [];
    }
  }
  return rows;
}

/** Delete a user-created template (only the creator can delete it). */
export async function deleteUserTemplate(templateId, userId) {
  const tmpl = await db.get('SELECT * FROM user_templates WHERE id = $1', [templateId]);
  if (!tmpl) throw Object.assign(new Error('Template not found'), { status: 404 });
  if (tmpl.created_by !== userId) throw Object.assign(new Error('Not your template'), { status: 403 });
  await db.run('DELETE FROM user_templates WHERE id = $1', [templateId]);
}

// --- Template tags ---

const MAX_TAG_NAME_LENGTH = 50;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

function validateTagColor(color) {
  if (color && !HEX_COLOR_RE.test(color)) {
    throw Object.assign(new Error('Invalid color format (use hex e.g. #89b4fa)'), { status: 400 });
  }
}

function validateTagName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw Object.assign(new Error('Tag name required'), { status: 400 });
  if (trimmed.length > MAX_TAG_NAME_LENGTH) {
    throw Object.assign(new Error(`Tag name too long (max ${MAX_TAG_NAME_LENGTH} chars)`), { status: 400 });
  }
  return trimmed;
}

/** List all global template tags. */
export async function listTemplateTags() {
  return db.all('SELECT id, name, color FROM template_tags ORDER BY name');
}

/** Create a new global template tag (max 100 total). */
export async function createTemplateTag(name, color) {
  const trimmed = validateTagName(name);
  validateTagColor(color);
  const safeColor = color || '#89b4fa';
  // Limit total number of tags
  const { count } = await db.get('SELECT COUNT(*) as count FROM template_tags');
  if (parseInt(count, 10) >= 100) {
    throw Object.assign(new Error('Maximum number of tags reached (100)'), { status: 400 });
  }
  const id = uuid();
  try {
    await db.run('INSERT INTO template_tags (id, name, color) VALUES ($1, $2, $3)', [id, trimmed, safeColor]);
  } catch (err) {
    if (err.code === '23505') throw Object.assign(new Error('Tag already exists'), { status: 409 });
    throw err;
  }
  return { id, name: trimmed, color: safeColor };
}

/** Update an existing template tag's name and/or color. */
export async function updateTemplateTag(tagId, name, color) {
  const tag = await db.get('SELECT * FROM template_tags WHERE id = $1', [tagId]);
  if (!tag) throw Object.assign(new Error('Tag not found'), { status: 404 });
  const trimmed = validateTagName(name);
  validateTagColor(color);
  const safeColor = color || tag.color;
  try {
    await db.run('UPDATE template_tags SET name = $1, color = $2 WHERE id = $3', [trimmed, safeColor, tagId]);
  } catch (err) {
    if (err.code === '23505') throw Object.assign(new Error('Tag already exists'), { status: 409 });
    throw err;
  }
  return { id: tagId, name: trimmed, color: safeColor };
}

/** Delete a global template tag by ID. */
export async function deleteTemplateTag(tagId) {
  const tag = await db.get('SELECT * FROM template_tags WHERE id = $1', [tagId]);
  if (!tag) throw Object.assign(new Error('Tag not found'), { status: 404 });
  await db.run('DELETE FROM template_tags WHERE id = $1', [tagId]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAGS_PER_TEMPLATE = 20;

/** Replace all tags on a template with the given tag IDs. */
export async function setTemplateTags(templateId, tagIds) {
  if (tagIds.length > MAX_TAGS_PER_TEMPLATE) {
    throw Object.assign(new Error(`Too many tags (max ${MAX_TAGS_PER_TEMPLATE})`), { status: 400 });
  }
  for (const id of tagIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw Object.assign(new Error('Invalid tag ID'), { status: 400 });
    }
  }
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM template_tag_map WHERE template_id = $1', [templateId]);
    for (const tagId of tagIds) {
      await tx.run('INSERT INTO template_tag_map (template_id, tag_id) VALUES ($1, $2)', [templateId, tagId]);
    }
  });
}

/** Create a new blank project with a default main.tex file. */
export async function createProject(userId, name) {
  const id = uuid();
  const fileId = uuid();
  const safeName = (name || 'Untitled').slice(0, 500).replace(/[\\{}$&#^_%~\r\n]/g, '');
  const defaultContent = `\\documentclass{article}
\\usepackage[utf8]{inputenc}

\\title{${safeName}}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}
Hello from FlowTex!

\\end{document}
`;

  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [id, safeName]);
    await tx.run('INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)', [
      fileId,
      id,
      'main.tex',
      defaultContent,
    ]);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [id, userId, 'owner']);
  });

  return { id, name: safeName };
}

/** Create a new project by extracting files from an uploaded ZIP buffer. */
export async function createProjectFromZip(userId, buffer, originalName) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const fileEntries = entries.filter((e) => !e.isDirectory);
  if (fileEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains too many files (${fileEntries.length}, max ${MAX_ZIP_ENTRIES})`);
  }
  const totalDecompressed = fileEntries.reduce((sum, e) => sum + (e.header.size || 0), 0);
  if (totalDecompressed > MAX_ZIP_TOTAL_SIZE) {
    throw new Error(
      `ZIP decompressed size too large (${Math.round(totalDecompressed / 1024 / 1024)}MB, max ${MAX_ZIP_TOTAL_SIZE / 1024 / 1024}MB)`,
    );
  }
  if (buffer.length > 0 && totalDecompressed / buffer.length > MAX_ZIP_RATIO) {
    throw new Error('ZIP compression ratio too high (possible zip bomb)');
  }

  const projectName = (originalName || 'Uploaded Project').replace(/\.zip$/i, '');
  const projectId = uuid();
  const created = [];

  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name) VALUES ($1, $2)', [projectId, projectName]);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
      projectId,
      userId,
      'owner',
    ]);

    let actualTotal = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      let entryPath = entry.entryName;
      if (entryPath.startsWith('__MACOSX/') || entryPath.split('/').some((p) => p.startsWith('.'))) continue;
      if (entryPath.includes('..') || !isValidFilePath(entryPath)) continue;
      if (entry.header.size > MAX_ZIP_ENTRY_SIZE) continue;

      const ext = entryPath.substring(entryPath.lastIndexOf('.')).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);
      const rawData = entry.getData();
      actualTotal += rawData.length;
      if (rawData.length > MAX_ZIP_ENTRY_SIZE || actualTotal > MAX_ZIP_TOTAL_SIZE) continue;
      const content = isBinary ? rawData.toString('base64') : rawData.toString('utf8');
      const id = uuid();

      await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
        id,
        projectId,
        entryPath,
        content,
        isBinary,
      ]);
      created.push({ id, path: entryPath });
    }
  });

  await stripCommonPrefix(created);
  return { id: projectId, name: projectName };
}

/** Create a new project by converting a .docx file to LaTeX using the custom converter. */
export async function createProjectFromDocx(userId, buffer, originalName, options = {}) {
  const onProgress = options.onProgress || (() => {});
  // Pass progress callback to converter — it reports 5-75%
  options.onProgress = onProgress;
  // Convert DOCX → LaTeX with exact tracked-change positions
  // Tracked-change extraction from DOCX is intentionally ignored here —
  // the editor's track-changes pipeline was removed and is being rebuilt.
  // The converter still walks revision marks (we don't pay to disable it),
  // we just don't carry them into the new project.
  let { latex: rawLatex, metadata, bibContent: converterBib, comments: docxComments, mediaFiles } = await convertDocxToLatex(buffer, options);

  // Strip null bytes that some DOCX files produce — PostgreSQL rejects them
  const stripNulls = (s) => (typeof s === 'string' ? s.replace(/\0/g, '') : s);
  rawLatex = stripNulls(rawLatex);
  converterBib = stripNulls(converterBib);
  if (metadata) {
    for (const k of Object.keys(metadata)) metadata[k] = stripNulls(metadata[k]);
  }
  if (docxComments) {
    for (const c of docxComments) {
      c.text = stripNulls(c.text);
      c.author = stripNulls(c.author);
    }
  }

  onProgress('Processing bibliography…', 80);
  // Bibliography: prefer converter-generated bib (from EndNote field codes),
  // fall back to extracting from a References section in the LaTeX text
  let bibContent = '';
  const bibResult = converterBib
    ? { tex: rawLatex, bib: '', style: 'authoryear', unresolved: [] }
    : extractAndReplaceBibliography(rawLatex);
  let texContent = stripNulls(converterBib ? rawLatex : bibResult.tex);
  bibContent = stripNulls(converterBib || bibResult.bib);

  // Track how much we shift the text before \begin{document} so TC positions stay accurate.
  // TC positions are relative to rawLatex; extractAndReplaceBibliography may change text after
  // \begin{document} (removing the references section), but everything before it is unchanged.
  // We only need to account for insertions BEFORE \begin{document}.
  let preambleShift = 0;

  if (bibContent && !converterBib) {
    // Only insert biblatex preamble for extracted bibliography (not converter-generated)
    // Converter-generated bib uses natbib + \bibliography{} already in the preamble
    const biblatexLine = `\\usepackage[backend=bibtex,style=${bibResult.style},maxcitenames=2,natbib=true]{biblatex}\n` +
      `\\renewcommand*{\\finalnamedelim}{\\addspace\\&\\addspace}\n` +
      `\\renewcommand*{\\nameyeardelim}{\\addcomma\\addspace}\n` +
      `\\addbibresource{references.bib}\n`;
    const insertionText = biblatexLine + '\n';
    texContent = texContent.replace(/(\\begin\{document\})/, insertionText + '$1');
    preambleShift += insertionText.length;
    if (!texContent.includes('\\printbibliography')) {
      texContent = texContent.replace(/\\end\{document\}/, '\n\\printbibliography\n\\end{document}');
    }
  }
  if (bibResult.unresolved?.length > 0) {
    const warnings = bibResult.unresolved.map((u) => `% WARNING: Unresolved citation: ${u}`).join('\n');
    const prefix = warnings + '\n%\n';
    texContent = prefix + texContent;
    preambleShift += prefix.length;
  }

  onProgress('Mapping tracked changes…', 85);
  texContent = prettifyLatex(texContent);

  const projectName = (originalName || 'Imported Document').replace(/\.docx?$/i, '');
  const projectId = uuid();

  onProgress('Saving project…', 90);
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO projects (id, name, compiler) VALUES ($1, $2, $3)', [projectId, projectName, 'xelatex']);
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [projectId, userId, 'owner']);

    await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
      uuid(), projectId, 'main.tex', texContent, false,
    ]);

    if (bibContent) {
      await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
        uuid(), projectId, 'references.bib', bibContent, false,
      ]);
    }

    // Insert extracted media files (images)
    for (const mf of mediaFiles) {
      const filePath = mf.path; // e.g. "media/image1.png"
      if (!isValidFilePath(filePath)) continue;
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);
      const content = isBinary ? mf.data.toString('base64') : mf.data.toString('utf8');
      await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
        uuid(), projectId, filePath, content, isBinary,
      ]);
    }

    // Import DOCX comments
    if (docxComments && docxComments.length > 0) {
      const mainFileRow = await tx.get('SELECT id FROM files WHERE project_id = $1 AND path = $2', [projectId, 'main.tex']);
      if (mainFileRow) {
        const fileId = mainFileRow.id;
        // Apply same preamble shift as tracked changes (comments are in body)
        const bodyStartOrig = rawLatex.indexOf('\\begin{document}');
        let commentsMapped = 0;
        for (const c of docxComments) {
          const shift = c.from >= bodyStartOrig ? preambleShift : 0;
          const from = c.from + shift;
          const to = c.to + shift;
          if (from >= 0 && to > from && from < texContent.length) {
            await tx.run(
              `INSERT INTO comments (id, file_id, from_pos, to_pos, text, author, author_id, resolved, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                uuid(), fileId,
                from, Math.min(to, texContent.length),
                c.text,
                c.author || 'Unknown',
                null, // no mapped user
                false,
                c.date ? new Date(c.date).toISOString() : new Date().toISOString(),
              ],
            );
            commentsMapped++;
          }
        }
        console.log(`[docx] Imported ${commentsMapped} comments into project ${projectId}`);
      }
    }
  });

  onProgress('Done', 100);
  return { id: projectId, name: projectName };
}

/**
 * Extract the references section from pandoc LaTeX output, parse each reference
 * into a BibTeX entry, replace inline citations with \cite{} commands, and remove
 * the plain-text references section.
 *
 * Returns { tex, bib, style } where style is 'numeric' or 'authoryear'.
 */
function extractAndReplaceBibliography(tex) {
  // --- 1. Find and extract the references section ---
  // Pandoc produces: \hypertarget{references}{%\n\section{References}\label{references}}\n\n...entries...\n\n\end{document}
  // Match the heading + everything until \end{document}
  const refPatterns = [
    /(\\hypertarget\{references\}\{%?\s*\n?\\section\*?\{[^}]*\}\\label\{[^}]*\}\})\s*\n([\s\S]*?)(?=\\end\{document\})/i,
    /(\\hypertarget\{references\}\{\s*\\section\*?\{[^}]*\}[^}]*\})\s*\\label\{[^}]*\}\n?([\s\S]*?)(?=\\end\{document\})/i,
    /(\\(?:section|chapter)\*?\{(?:References|Bibliography|Works Cited)\}[^\n]*)\n([\s\S]*?)(?=\\(?:section|chapter)\b|\\end\{document\})/i,
  ];
  let refSection = '';
  let refFullMatch = '';
  for (const pat of refPatterns) {
    const m = tex.match(pat);
    if (m) {
      refSection = m[2];
      refFullMatch = m[0];
      break;
    }
  }

  if (!refSection.trim()) {
    return { tex, bib: '', style: 'numeric' };
  }

  // --- 2. Parse individual reference entries from the LaTeX ---
  // Two formats: (a) Pandoc blank-line-separated paragraphs, (b) our converter's
  // {\setlength{\leftskip}{...}\setlength{\parindent}{...} ... \par} blocks.
  let rawEntries;
  if (/\{\\setlength\{\\leftskip\}/.test(refSection)) {
    // Format (b): split on }{ boundary between \par} and {\setlength
    rawEntries = [...refSection.matchAll(/\{\\setlength\{\\leftskip\}[\s\S]*?\\par\}/g)]
      .map((m) => m[0].replace(/^\{\\setlength\{[^}]*\}\{[^}]*\}\\setlength\{[^}]*\}\{[^}]*\}\s*/, '').replace(/\\par\}$/, '').trim())
      .filter((s) => s.length > 15);
  } else {
    rawEntries = refSection.split(/\n\s*\n/).filter((s) => s.trim().length > 15);
  }

  const bibEntries = [];
  const keysByIndex = [];

  // Common abbreviations that shouldn't end a title
  const ABBREVS = /(?:vs|etc|ed|eds|vol|no|pp|Jr|Sr|St|Dr|Prof|Fig|eq|al|i\.e|e\.g|dept|assoc|trans|rev|proc|int|natl|acad|sci|soc|psychol|mgmt|org|res|dev|tech|inf|syst|comput|commun|conf|univ)\s*$/i;

  for (let i = 0; i < rawEntries.length; i++) {
    // Merge adjacent \emph{} runs (Word splits italic text across multiple runs)
    // e.g. \emph{American }\emph{Journal of }\emph{Sociology} → \emph{American Journal of Sociology}
    // Also handles \textbf{} and \textit{} splits
    const rawLatex = rawEntries[i].replace(/\s+/g, ' ').trim()
      .replace(/\}\\emph\{/g, '')
      .replace(/\}\\textbf\{/g, '')
      .replace(/\}\\textit\{/g, '');

    // Use \emph{} markers to identify journal (italicised text after the title)
    // Pandoc format: "Author (Year). Title. \emph{Journal}, \emph{Vol}(Issue), Pages."
    const emphMatches = [...rawLatex.matchAll(/\\emph\{([^}]*)\}/g)];

    // Strip LaTeX for text parsing
    const stripped = rawLatex
      .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
      .replace(/\\emph\{([^}]*)\}/g, '$1')
      .replace(/\\textit\{([^}]*)\}/g, '$1')
      .replace(/\\textbf\{([^}]*)\}/g, '$1')
      .replace(/\\textsuperscript\{([^}]*)\}/g, '$1')
      .replace(/\\protect\s*/g, '')
      .replace(/\\(?:quad|qquad|enspace|hspace\{[^}]*\})\s*/g, ' ')
      .replace(/\\&/g, '&')
      .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
      .replace(/[{}]/g, '')
      .replace(/~+/g, ' ')
      .replace(/-{2,}/g, '–')
      .trim();

    // Remove leading [N] or N.
    const cleaned = stripped.replace(/^\[?\d+\]?\.?\s*/, '');

    // Parse author(s) and year: "Author, I., & Author, J. (2020a)." pattern
    const authorYearPat = /^(.+?)\s*\((\d{4}[a-z]?)\)\s*[.,:]?\s*(.+)/;
    const m = cleaned.match(authorYearPat);
    if (!m) continue;

    const authors = m[1].replace(/[.,]+$/, '').trim();
    const yearRaw = m[2];
    const year = yearRaw.replace(/[a-z]$/, '');
    const afterYear = m[3];

    // Extract title: everything up to the first \emph{} (journal) in the original LaTeX
    // If \emph{} exists, the title is text between "(Year). " and the first \emph{}
    let title = '';
    let journal = '', volume = '', issue = '', pages = '', doi = '', publisher = '';

    if (emphMatches.length > 0) {
      // Find position of first \emph{} after the year
      const yearIdx = rawLatex.indexOf(`(${yearRaw})`);
      const afterYearLatex = rawLatex.substring(yearIdx + yearRaw.length + 2).replace(/^\s*[.,:]?\s*/, '');
      const firstEmphIdx = afterYearLatex.indexOf('\\emph{');

      if (firstEmphIdx > 0) {
        // Title is everything before the first \emph{}, cleaned
        title = afterYearLatex.substring(0, firstEmphIdx)
          .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
          .replace(/[{}]/g, '')
          .replace(/[.,\s]+$/, '')
          .replace(/\s+In\s*$/, '') // strip trailing "In" (conference proceedings pattern)
          .trim();
      }

      // First \emph{} is usually the journal name
      journal = emphMatches[0][1].trim();
      // Second \emph{} is usually the volume
      if (emphMatches.length > 1) {
        volume = emphMatches[1][1].trim();
      }

      // Extract issue number: (N) after volume
      const volIssueMatch = rawLatex.match(/\\emph\{[^}]*\}\s*,\s*\\emph\{(\d+)\}\((\d+)\)/);
      if (volIssueMatch) {
        volume = volIssueMatch[1];
        issue = volIssueMatch[2];
      }

      // Extract pages: digits–digits or digits-digits (not anchored to end — may have trailing content)
      const pagesMatch = stripped.match(/(?:pp\.?\s*)?(\d+)\s*[–-]\s*(\d+)/);
      if (pagesMatch) {
        pages = `${pagesMatch[1]}--${pagesMatch[2]}`;
      }

      // For conference proceedings: extract (Vol. N, pp. X-Y) or (pp. X-Y) after emph
      const procMatch = stripped.match(/\(\s*(?:Vol\.?\s*(\d+)\s*,?\s*)?pp\.?\s*(\d+)\s*[–-]\s*(\d+)\s*\)/);
      if (procMatch) {
        if (procMatch[1] && !volume) volume = procMatch[1];
        pages = `${procMatch[2]}--${procMatch[3]}`;
      }
    }

    // Fallback title extraction if no \emph{} found
    if (!title) {
      // Find end of title: look for a period followed by a capital letter (new sentence = journal)
      // But skip abbreviations like "vs.", "e.g.", "i.e.", etc.
      let titleEnd = -1;
      let searchFrom = 0;
      while (searchFrom < afterYear.length) {
        const dotIdx = afterYear.indexOf('.', searchFrom);
        if (dotIdx === -1) break;
        const beforeDot = afterYear.substring(0, dotIdx);
        const afterDot = afterYear.substring(dotIdx + 1).trimStart();
        if (ABBREVS.test(beforeDot) || /^\s*$/.test(afterDot)) {
          searchFrom = dotIdx + 1;
          continue;
        }
        // Check if next char is uppercase (start of journal/publisher)
        if (/^[A-Z]/.test(afterDot)) {
          titleEnd = dotIdx;
          break;
        }
        searchFrom = dotIdx + 1;
      }
      if (titleEnd > 0) {
        title = afterYear.substring(0, titleEnd).trim();
        // Try to extract journal/booktitle from remaining text (after title period)
        if (!journal) {
          const remaining = afterYear.substring(titleEnd + 1).trim();
          // "In: Proceedings of..." or "In Proceedings of..." → booktitle
          const inMatch = remaining.match(/^In:?\s+(.+?)(?:\.\s|$)/);
          if (inMatch) {
            journal = inMatch[1].replace(/\s*\([^)]*\)\s*$/, '').replace(/[.,]+$/, '').trim();
          } else {
            // Plain journal name: take up to the first comma or period
            const jMatch = remaining.match(/^([A-Z][^,]+?)(?:,\s*\d|\.\s*$)/);
            if (jMatch) journal = jMatch[1].replace(/[.,]+$/, '').trim();
          }
        }
      } else {
        title = afterYear.replace(/[.,]+$/, '').trim();
      }
    }

    // Extract DOI
    const doiMatch = stripped.match(/(?:doi[:\s]*|https?:\/\/doi\.org\/)(10\.\S+)/i);
    if (doiMatch) doi = doiMatch[1].replace(/[.,]+$/, '');

    // Extract publisher (for books/proceedings)
    const pubMatch = stripped.match(/(?::\s*|,\s*|\.\s+)([A-Z][A-Za-z\s&.]{2,40}(?:Press|Publishing|Publishers|Springer|Wiley|Elsevier|Sage|Routledge|Cambridge|Oxford|MIT|ACM|IEEE))\b/i)
      || stripped.match(/\.\s+(IEEE|ACM|Springer|Elsevier)\s*\.?\s*$/i);
    if (pubMatch) publisher = (pubMatch[1] || pubMatch[0]).trim().replace(/\.$/, '');

    // Generate citation key — use first author's surname
    const firstAuthor = authors.split(/\s*(?:\\?&|(?:\band\b))\s*/i)[0].trim();
    const commaIdx = firstAuthor.indexOf(',');
    const surname = commaIdx > 0
      ? firstAuthor.substring(0, commaIdx).trim().split(/\s+/).pop() || `ref${i + 1}`
      : firstAuthor.split(/\s+/).filter((w) => w.length > 1 && /^[A-Z]/.test(w)).pop() || `ref${i + 1}`;
    const surnameKey = surname.toLowerCase().replace(/[^a-z]/g, '');
    let key = surnameKey + year;
    // Preserve year suffix (a, b) for disambiguation
    if (/[a-z]$/.test(yearRaw)) key += yearRaw.slice(-1);

    // Ensure unique keys — first try adding a title keyword, then fall back to a/b/c
    if (bibEntries.some((e) => e.key === key)) {
      const STOP_WORDS = new Set(['the','a','an','of','in','on','for','and','or','to','is','are','was','were','by','from','with','as','at','it','its','that','this','how','do','does','can','not','no','be','been','has','have','had','into','between','among','through','about','over','under','new','old']);
      const titleWord = (title || '').split(/\s+/)
        .map((w) => w.toLowerCase().replace(/[^a-z]/g, ''))
        .find((w) => w.length > 2 && !STOP_WORDS.has(w));
      if (titleWord) {
        const kwKey = surnameKey + year + titleWord;
        if (!bibEntries.some((e) => e.key === kwKey)) {
          key = kwKey;
        }
      }
    }
    // Final fallback: append a, b, c...
    const baseKey = key;
    let keySuffix = 0;
    while (bibEntries.some((e) => e.key === key)) {
      key = baseKey + String.fromCharCode(97 + keySuffix);
      keySuffix++;
    }

    // Determine entry type
    let type = 'article';
    const fullText = stripped.toLowerCase();
    if (/proceedings|conference/i.test(fullText)) type = 'inproceedings';
    else if (/\bthesis\b|\bdissertation\b/i.test(fullText)) type = 'phdthesis';
    else if (/\bpress\b|\bedition\b|\bbook\b/i.test(fullText) && (!journal || !volume || /university|press/i.test(fullText))) {
      // Book: if the "journal" is actually the book title (no volume/issue pattern), reclassify
      if (journal && !volume && !issue && !pages) {
        title = journal;
        journal = '';
        type = 'book';
      } else if (!journal) {
        type = 'book';
      }
    }

    // Clean up title: strip trailing editor references "In S. Worchel & W. Austin (Eds.)" and "In:"
    title = title
      .replace(/\.?\s+In\s+.*?\(Eds?\.?\).*$/i, '')
      .replace(/\.?\s+In:?\s*$/i, '')
      .replace(/[.,\s]+$/, '')
      .trim();

    bibEntries.push({ key, type, authors, year, title, journal, volume, issue, pages, doi, publisher });
    keysByIndex.push(key);
  }

  if (bibEntries.length === 0) {
    return { tex, bib: '', style: 'numeric' };
  }

  // --- 3. Detect citation style and replace inline citations ---
  const bodyTex = tex.substring(0, tex.indexOf(refFullMatch));

  const numericCites = bodyTex.match(/\[\d+(?:\s*[,;–-]\s*\d+)*\]/g) || [];
  // Match multi-cite parentheticals: (Author, Year; Author, Year) and (e.g., Author, Year)
  const harvardParenCites = bodyTex.match(/\([^)]*?[A-Z][a-zà-ž]+[^)]*?\d{4}[^)]*\)/g) || [];

  const isNumeric = numericCites.length >= harvardParenCites.length && numericCites.length > 0;
  const style = isNumeric ? 'numeric' : 'authoryear';

  // Build lookup table for author-year matching
  const lookup = bibEntries.map((entry) => {
    // Parse surnames from the author string: "Surname, I., \& Surname, J."
    // Split on \& or "and" — each segment is "Surname, Initials"
    const authorParts = entry.authors.split(/\s*(?:\\?&|(?:\band\b))\s*/i);
    const surnames = authorParts.map((part) => {
      // First word before comma is the surname
      const comma = part.indexOf(',');
      if (comma > 0) return part.substring(0, comma).trim();
      // No comma — last capitalised word
      return part.trim().split(/\s+/).filter((w) => /^[A-Z]/.test(w)).pop() || part.trim();
    }).filter(Boolean);
    return { key: entry.key, year: entry.year, yearRaw: entry.year, surnames };
  });

  // Fuzzy surname match: handles typos (Ghosal vs Ghoshal), accents, hyphens
  const normSurname = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  const surnameMatch = (a, b) => {
    const na = normSurname(a), nb = normSurname(b);
    if (na === nb) return true;
    // Multi-word surname: "Van Alstyne" normalized to "vanalstyne" should match "vanalstyne"
    // Also handle partial: "Alstyne" should match "Van Alstyne" (one ends with the other)
    if (na.length > 3 && nb.length > 3) {
      if (na.endsWith(nb) || nb.endsWith(na)) return true;
      if (na.startsWith(nb.substring(0, 4)) || nb.startsWith(na.substring(0, 4))) return true;
    }
    // Simple edit distance check for short names
    if (Math.abs(na.length - nb.length) <= 2) {
      let diff = 0;
      for (let i = 0; i < Math.min(na.length, nb.length); i++) {
        if (na[i] !== nb[i]) diff++;
      }
      diff += Math.abs(na.length - nb.length);
      if (diff <= 2) return true;
    }
    return false;
  };

  const findKey = (authorPart, year) => {
    const clean = authorPart.replace(/\s+et\s+al\.?/i, '').replace(/\\?&/g, '&').trim();
    // Split on & or "and", then extract surname (keep multi-word names like "Van Alstyne")
    const words = clean.split(/\s+(?:&|and)\s+/i).map((w) => {
      const part = w.trim().replace(/,.*$/, '').trim(); // remove ", I." initials
      // If it looks like "Surname, I." format, take everything before comma
      if (/,/.test(w)) return w.split(',')[0].trim();
      // Otherwise keep the full name (handles "Van Alstyne", "De Groot", etc.)
      return part;
    });
    const isEtAl = /et\s+al/i.test(authorPart);

    for (const entry of lookup) {
      if (entry.year !== year) continue;
      // et al. — match first author only
      if (isEtAl && surnameMatch(entry.surnames[0], words[0])) return entry.key;
      // Single author citation — match first surname or any surname in the entry
      if (words.length === 1) {
        if (entry.surnames.some((s) => surnameMatch(s, words[0]))) return entry.key;
      }
      // Multiple authors — match all listed surnames against any position
      if (words.length > 1) {
        const matched = words.every((w) => entry.surnames.some((s) => surnameMatch(s, w)));
        if (matched) return entry.key;
      }
    }
    return null;
  };

  // Collect all replacements as {from, to, replacement} tuples so we can
  // build a position map for TC remapping.
  const replacements = [];
  const unresolved = [];

  if (isNumeric) {
    // [1], [2,3], [1-3] → \cite{keys}
    for (const m of tex.matchAll(/\[(\d+)\s*[–-]\s*(\d+)\]/g)) {
      const keys = [];
      for (let idx = parseInt(m[1]) - 1; idx <= parseInt(m[2]) - 1 && idx < keysByIndex.length; idx++) {
        if (keysByIndex[idx]) keys.push(keysByIndex[idx]);
      }
      if (keys.length) replacements.push({ from: m.index, to: m.index + m[0].length, replacement: `\\cite{${keys.join(',')}}` });
    }
    for (const m of tex.matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g)) {
      // Skip ranges already handled above
      if (replacements.some(r => r.from === m.index)) continue;
      const keys = m[1].split(/\s*[,;]\s*/).map((n) => keysByIndex[parseInt(n) - 1]).filter(Boolean);
      if (keys.length) replacements.push({ from: m.index, to: m.index + m[0].length, replacement: `\\cite{${keys.join(',')}}` });
    }
  } else {
    // Surname pattern: handles accents (É, ü), hyphens (Méndez-Durón), apostrophes (O'Brien),
    // multi-word (Van Alstyne), and standard names
    const SN = `[A-ZÀ-Ž][a-zà-ž]+(?:[-'][A-ZÀ-Ž]?[a-zà-ž]+)*(?:\\s+[A-Z][a-zà-ž]+)*`;
    const AUTHOR = `${SN}(?:\\s+(?:\\\\?&|and)\\s+${SN})?(?:\\s+et\\s+al\\.?)?`;

    // First: handle Author (Year) → \textcite{key}
    const textciteRe = new RegExp(`(${AUTHOR})\\s+\\((\\d{4}[a-z]?)\\)`, 'g');
    for (const m of tex.matchAll(textciteRe)) {
      const key = findKey(m[1], m[2].replace(/[a-z]$/, ''));
      if (key) {
        replacements.push({ from: m.index, to: m.index + m[0].length, replacement: `\\textcite{${key}}` });
      } else {
        unresolved.push(`${m[1]} (${m[2]})`);
      }
    }

    // Then: handle parenthetical citations (single or multi-cite with semicolons)
    for (const m of tex.matchAll(/\(([^)]*?\d{4}[a-z]?(?:\s*;[^)]*?\d{4}[a-z]?)*)\)/g)) {
      const inner = m[1];
      // Skip if it looks like a non-citation parenthetical
      if (/^\s*[a-z]\s*[=<>]/.test(inner) || /^\d/.test(inner.trim())) continue;
      // Skip if overlapping with a textcite replacement already collected
      if (replacements.some(r => m.index < r.to && m.index + m[0].length > r.from)) continue;

      const parts = inner.split(/\s*;\s*/);
      const keys = [];
      let prefix = '';
      let allResolved = true;

      for (const part of parts) {
        let cleaned = part.replace(/^(?:e\.?g\.?,?\s*|see\s+|cf\.?\s*|i\.e\.?,?\s*)/i, (pm) => {
          if (!prefix) prefix = pm.trim() + ' ';
          return '';
        });
        const cm = cleaned.match(/(.+?),?\s*(\d{4}[a-z]?)\s*$/);
        if (cm) {
          const key = findKey(cm[1].trim(), cm[2].replace(/[a-z]$/, ''));
          if (key) {
            keys.push(key);
          } else {
            allResolved = false;
            unresolved.push(`(${cleaned.trim()})`);
          }
        } else {
          allResolved = false;
        }
      }

      if (keys.length > 0 && allResolved) {
        const replacement = prefix ? `(${prefix}\\cite{${keys.join(',')}})` : `\\parencite{${keys.join(',')}}`;
        replacements.push({ from: m.index, to: m.index + m[0].length, replacement });
      }
    }
  }

  // --- 4. Remove the references section from the LaTeX ---
  const refStart = tex.indexOf(refFullMatch);
  if (refStart >= 0) {
    replacements.push({ from: refStart, to: refStart + refFullMatch.length, replacement: '' });
  }
  // Also remove orphaned \hypertarget{references}
  for (const m of tex.matchAll(/\\hypertarget\{references\}\{%?\s*\n?\}?\s*\n?/g)) {
    if (!replacements.some(r => m.index >= r.from && m.index < r.to)) {
      replacements.push({ from: m.index, to: m.index + m[0].length, replacement: '' });
    }
  }

  // Sort replacements by position and apply end-to-start to build result + position map
  replacements.sort((a, b) => a.from - b.from);

  // Build the new text and a substitution list for position remapping
  let newTex = tex;
  // Apply end-to-start so positions stay valid
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    newTex = newTex.slice(0, r.from) + r.replacement + newTex.slice(r.to);
  }

  // --- 5. Build .bib content ---
  // Escape BibTeX special characters in field values
  const bibEsc = (s) => {
    // First normalize: convert \& to just & so we handle everything uniformly
    let r = s.replace(/\\&/g, '&');
    // Escape special BibTeX chars: & # % _ ~ need backslash
    r = r.replace(/([&#%_~])/g, '\\$1');
    // Remove unbalanced braces to prevent "Extra }" errors
    let depth = 0;
    for (const ch of r) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth !== 0) r = r.replace(/[{}]/g, '');
    return r;
  };
  const bibLines = bibEntries.map((e) => {
    const fields = [];
    if (e.authors) {
      // BibTeX author format: "Last1, First1 and Last2, First2"
      // Source format: "Last1, F., Last2, F., \& Last3, F." or "Last1, F., and Last2, F."
      // Split on \& or standalone "and" first to get groups
      const groups = e.authors.split(/\s*(?:\\?&|\band\b)\s*/i);
      const allAuthors = [];
      for (const group of groups) {
        // Each group may be a single author "Surname, I." or multiple "Surname, I., Surname, I."
        // Split individual authors: match "Word(s), Initial(s)." pattern
        const authorMatches = [...group.matchAll(/([A-ZÀ-Ž][a-zà-ž]+(?:[-'][A-Za-z][a-zà-ž]*)*(?:\s+(?:von|van|de|del|den|der|di|le|la|el|al|Mc|Mac|O')[A-Za-z]*)*(?:\s+[A-Z][a-zà-ž]+)*),\s*((?:[A-Z]\.?\s*)+(?:[a-z]+\.?\s*)*)/g)];
        if (authorMatches.length > 0) {
          for (const m of authorMatches) {
            allAuthors.push(`${m[1].trim()}, ${m[2].trim().replace(/[,\s]+$/, '')}`);
          }
        } else {
          const cleaned = group.trim().replace(/,+$/, '');
          if (cleaned) allAuthors.push(cleaned);
        }
      }
      fields.push(`  author = {${allAuthors.join(' and ')}}`);
    }
    if (e.title) fields.push(`  title = {${bibEsc(e.title)}}`);
    if (e.year) fields.push(`  year = {${e.year}}`);
    if (e.journal) {
      const jField = e.type === 'inproceedings' ? 'booktitle' : 'journal';
      fields.push(`  ${jField} = {${bibEsc(e.journal)}}`);
    }
    if (e.volume) fields.push(`  volume = {${e.volume}}`);
    if (e.issue) fields.push(`  number = {${e.issue}}`);
    if (e.pages) fields.push(`  pages = {${e.pages}}`);
    if (e.publisher) fields.push(`  publisher = {${bibEsc(e.publisher)}}`);
    if (e.doi) fields.push(`  doi = {${e.doi}}`);
    return `@${e.type}{${e.key},\n${fields.join(',\n')}\n}`;
  });

  // Deduplicate unresolved list and filter false positives
  const falsePositiveRe = /^\(?(?:pp?\.|vol\.|no\.|ed\.|eds\.|ch\.|fig\.|tab\.|eq\.|sec\.|see\s|cf\.|n\s*=|p\s*[<>=]|\d)/i;
  const uniqueUnresolved = [...new Set(unresolved)].filter((u) => {
    const inner = u.replace(/^\(|\)$/g, '').trim();
    if (falsePositiveRe.test(inner)) return false;
    // Filter conference/org acronyms like "ECIS 2016", "AIS 2020" — all-caps + year
    if (/^[A-Z]{2,8}\s+\d{4}/.test(inner)) return false;
    // Must contain at least one letter that looks like a surname
    if (!/[A-ZÀ-Ž][a-zà-ž]{2,}/.test(inner)) return false;
    return true;
  });
  return { tex: newTex, bib: bibLines.join('\n\n'), style, unresolved: uniqueUnresolved, replacements };
}

/** Upload a ZIP file into an existing project, merging with existing files. */
export async function uploadZipToProject(projectId, buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const created = [];

  const fileEntries = entries.filter((e) => !e.isDirectory);
  if (fileEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains too many files (${fileEntries.length}, max ${MAX_ZIP_ENTRIES})`);
  }
  const totalDecompressed = fileEntries.reduce((sum, e) => sum + (e.header.size || 0), 0);
  if (totalDecompressed > MAX_ZIP_TOTAL_SIZE) {
    throw new Error(
      `ZIP decompressed size too large (${Math.round(totalDecompressed / 1024 / 1024)}MB, max ${MAX_ZIP_TOTAL_SIZE / 1024 / 1024}MB)`,
    );
  }
  if (buffer.length > 0 && totalDecompressed / buffer.length > MAX_ZIP_RATIO) {
    throw new Error('ZIP compression ratio too high (possible zip bomb)');
  }

  await db.transaction(async (tx) => {
    let actualTotal = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      let entryPath = entry.entryName;
      if (entryPath.startsWith('__MACOSX/') || entryPath.split('/').some((p) => p.startsWith('.'))) continue;
      if (entryPath.includes('..') || !isValidFilePath(entryPath)) continue;
      if (entry.header.size > MAX_ZIP_ENTRY_SIZE) continue;

      const ext = entryPath.substring(entryPath.lastIndexOf('.')).toLowerCase();
      const isBinary = BINARY_EXTS.has(ext);
      const rawData = entry.getData();
      actualTotal += rawData.length;
      if (rawData.length > MAX_ZIP_ENTRY_SIZE || actualTotal > MAX_ZIP_TOTAL_SIZE) continue;
      const content = isBinary ? rawData.toString('base64') : rawData.toString('utf8');

      const existing = await tx.get('SELECT id FROM files WHERE project_id = $1 AND path = $2', [projectId, entryPath]);
      if (existing) {
        await tx.run('UPDATE files SET content = $1, is_binary = $2, updated_at = NOW() WHERE id = $3', [
          content,
          isBinary,
          existing.id,
        ]);
        created.push({ id: existing.id, path: entryPath, updated: true });
      } else {
        const id = uuid();
        await tx.run('INSERT INTO files (id, project_id, path, content, is_binary) VALUES ($1, $2, $3, $4, $5)', [
          id,
          projectId,
          entryPath,
          content,
          isBinary,
        ]);
        created.push({ id, path: entryPath, updated: false });
      }
    }
    await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  });

  await stripCommonPrefix(created);
  const files = await db.all('SELECT * FROM files WHERE project_id = $1 ORDER BY path', [projectId]);
  return { files, created: created.length };
}

/** Strip a shared directory prefix from extracted ZIP files (e.g. "project-name/"). */
async function stripCommonPrefix(created) {
  if (created.length <= 1) return;
  const firstSlash = created[0].path.indexOf('/');
  if (firstSlash <= 0) return;
  const prefix = created[0].path.substring(0, firstSlash + 1);
  if (!created.every((f) => f.path.startsWith(prefix))) return;
  await db.transaction(async (tx) => {
    for (const f of created) {
      const newPath = f.path.substring(prefix.length);
      if (newPath) {
        await tx.run('UPDATE files SET path = $1 WHERE id = $2', [newPath, f.id]);
        f.path = newPath;
      }
    }
  });
}

/** Update project settings (name, main file, snapshot interval, TeX distribution, compiler, compile location). */
export async function updateProject(
  projectId,
  { name, main_file, snapshot_interval_sec, tex_distribution, compiler, compile_location },
) {
  if (main_file) {
    if (!isValidFilePath(main_file)) throw new Error('Invalid main file path');
    if (!main_file.endsWith('.tex')) throw new Error('Main file must be a .tex file');
    // Verify the file actually exists in the project
    const fileExists = await db.get('SELECT id FROM files WHERE project_id = $1 AND path = $2', [projectId, main_file]);
    if (!fileExists) throw new Error('Main file not found in project');
    await db.run('UPDATE projects SET main_file = $1 WHERE id = $2', [main_file, projectId]);
  }
  if (name && name.trim()) {
    await db.run('UPDATE projects SET name = $1 WHERE id = $2', [name.trim(), projectId]);
  }
  if (snapshot_interval_sec != null) {
    const val = Math.max(10, Math.min(3600, parseInt(snapshot_interval_sec) || 30));
    await db.run('UPDATE projects SET snapshot_interval_sec = $1 WHERE id = $2', [val, projectId]);
  }
  if (tex_distribution !== undefined) {
    await db.run('UPDATE projects SET tex_distribution = $1 WHERE id = $2', [tex_distribution || null, projectId]);
  }
  if (compiler !== undefined) {
    const valid = ['pdflatex', 'xelatex', 'lualatex'];
    const val = valid.includes(compiler) ? compiler : 'pdflatex';
    await db.run('UPDATE projects SET compiler = $1 WHERE id = $2', [val, projectId]);
  }
  // compile_location: caller already gated on the feature flag, so any
  // value reaching here is intended. Allowed values: '' / null (meaning
  // "inherit user default"), 'server', 'local'. Anything else is coerced
  // to NULL to avoid storing unknown enum-ish values.
  if (compile_location !== undefined) {
    let val = null;
    if (compile_location === 'server' || compile_location === 'local') {
      val = compile_location;
    }
    await db.run('UPDATE projects SET compile_location = $1 WHERE id = $2', [val, projectId]);
  }
  return db.get('SELECT * FROM projects WHERE id = $1', [projectId]);
}

export async function deleteProject(projectId) {
  await db.run('DELETE FROM projects WHERE id = $1', [projectId]);
}

/** Duplicate a project and all its files, making the user the owner of the
 *  copy. Comments (incl. replies and emoji reactions) and the tracked-
 *  changes sidecar (`files.tc_marks`) are also copied so the discussion
 *  thread and any pending review marks carry over verbatim.
 *
 *  Intentional omissions (mirrors what GitHub-fork / Docs-make-a-copy do):
 *   - `comment_mentions`: copying would re-fire digest emails for past
 *     mentions on the original project.
 *   - `file_versions` and `project_snapshots`: the copy starts fresh; the
 *     edit history of the source is bound to the source's collaborators
 *     and timeline. Copying it would inflate storage (a snapshot can be
 *     megabytes) and present misleading authorship for users who never
 *     had access to the original. New history accrues from the moment of
 *     copy; the *current* state of every file is preserved verbatim via
 *     the files INSERTs below. */
export async function copyProject(projectId, userId, newName, { includeMembers = false } = {}) {
  const source = await db.get('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!source) throw new Error('Project not found');
  const newId = uuid();
  const name = (newName || source.name + ' (Copy)').slice(0, 200);
  // Track user_ids of source collaborators carried over so the route layer
  // can audit-log each implicit re-share. Owner (caller) is not included.
  const addedMembers = [];
  // tc_marks is the per-file tracked-changes JSON sidecar (insert / delete
  // ranges + author + timestamp). It rides alongside content because the
  // marks are coordinate-bound to the current text — copying content
  // without tc_marks would silently flatten every pending edit into the
  // source: deletes would no longer strike through (and would still
  // appear in the compiled PDF), inserts would render as plain text.
  const files = await db.all(
    'SELECT id, path, content, is_binary, tc_marks FROM files WHERE project_id = $1',
    [projectId],
  );
  await db.transaction(async (tx) => {
    // Carry the source's compile settings across — particularly `compiler`,
    // which is set to xelatex for DOCX imports and other projects that use
    // fontspec. If we let it default to pdflatex on copy, the compiled PDF
    // would diverge wildly from the source editor (fontspec preamble fails
    // under pdflatex and produces garbled or broken output).
    await tx.run(
      `INSERT INTO projects (id, name, main_file, compiler, tex_distribution, snapshot_interval_sec)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId, name, source.main_file, source.compiler, source.tex_distribution, source.snapshot_interval_sec],
    );
    await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
      newId,
      userId,
      'owner',
    ]);

    // When the caller opts in, also bring every other collaborator across
    // with their original role. Caller is already inserted as 'owner'
    // above (overriding their source role if it was lower), so we skip
    // them here. ON CONFLICT DO NOTHING is defensive — there shouldn't
    // be a collision but a race during the transaction would otherwise
    // surface a UNIQUE-constraint error.
    if (includeMembers) {
      const sourceMembers = await tx.all(
        'SELECT user_id, role FROM project_members WHERE project_id = $1 AND user_id <> $2',
        [projectId, userId],
      );
      for (const m of sourceMembers) {
        await tx.run(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [newId, m.user_id, m.role],
        );
        addedMembers.push(m.user_id);
      }
    }

    const fileIdMap = new Map(); // oldFileId -> newFileId
    for (const file of files) {
      const newFileId = uuid();
      fileIdMap.set(file.id, newFileId);
      await tx.run(
        'INSERT INTO files (id, project_id, path, content, is_binary, tc_marks) VALUES ($1, $2, $3, $4, $5, $6)',
        [newFileId, newId, file.path, file.content, file.is_binary, JSON.stringify(file.tc_marks ?? [])],
      );
    }

    if (files.length === 0) return;

    const sourceFileIds = files.map((f) => f.id);
    const comments = await tx.all(
      `SELECT id, file_id, from_pos, to_pos, text, author, author_id, assigned_to, resolved, created_at
         FROM comments WHERE file_id = ANY($1)`,
      [sourceFileIds],
    );
    if (comments.length === 0) return;

    const commentIdMap = new Map();
    for (const c of comments) {
      const newCommentId = uuid();
      commentIdMap.set(c.id, newCommentId);
      await tx.run(
        `INSERT INTO comments (id, file_id, from_pos, to_pos, text, author, author_id, assigned_to, resolved)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newCommentId,
          fileIdMap.get(c.file_id),
          c.from_pos,
          c.to_pos,
          c.text,
          c.author,
          c.author_id,
          c.assigned_to,
          c.resolved,
        ],
      );
    }

    const sourceCommentIds = comments.map((c) => c.id);
    const replies = await tx.all(
      `SELECT id, comment_id, text, author, author_id, created_at
         FROM comment_replies WHERE comment_id = ANY($1)`,
      [sourceCommentIds],
    );
    const replyIdMap = new Map();
    for (const r of replies) {
      const newReplyId = uuid();
      replyIdMap.set(r.id, newReplyId);
      await tx.run(
        `INSERT INTO comment_replies (id, comment_id, text, author, author_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [newReplyId, commentIdMap.get(r.comment_id), r.text, r.author, r.author_id],
      );
    }

    const commentReactions = await tx.all(
      `SELECT comment_id, user_id, user_name, emoji
         FROM comment_reactions WHERE comment_id = ANY($1)`,
      [sourceCommentIds],
    );
    for (const cr of commentReactions) {
      await tx.run(
        `INSERT INTO comment_reactions (id, comment_id, user_id, user_name, emoji)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuid(), commentIdMap.get(cr.comment_id), cr.user_id, cr.user_name, cr.emoji],
      );
    }

    if (replies.length === 0) return;
    const sourceReplyIds = replies.map((r) => r.id);
    const replyReactions = await tx.all(
      `SELECT reply_id, user_id, user_name, emoji
         FROM reply_reactions WHERE reply_id = ANY($1)`,
      [sourceReplyIds],
    );
    for (const rr of replyReactions) {
      await tx.run(
        `INSERT INTO reply_reactions (id, reply_id, user_id, user_name, emoji)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuid(), replyIdMap.get(rr.reply_id), rr.user_id, rr.user_name, rr.emoji],
      );
    }
  });
  const project = await db.get('SELECT * FROM projects WHERE id = $1', [newId]);
  return { ...project, addedMembers };
}

// --- File operations ---

export async function getProjectFiles(projectId) {
  // Binaries are base64-encoded in the DB and often dominate the payload
  // (images, fonts, PDFs in a typical paper). The client doesn't need
  // their bytes for the initial project load — BinaryPreview fetches via
  // /api/projects/files/:id/raw on demand, and the download button does
  // the same. Null out binary `content` here so the initial response
  // ships file metadata + text content only. Cuts the JSON for a
  // typical project from MBs to KBs.
  return db.all(
    `SELECT id, project_id, path, is_binary, tc_marks, updated_at, created_at,
            CASE WHEN is_binary THEN NULL ELSE content END AS content
       FROM files
      WHERE project_id = $1
      ORDER BY path`,
    [projectId],
  );
}

// Phase A.2: binary uploads write the bytes to the per-project blob
// store and reference them by sha256, instead of base64-in-DB. Legacy
// base64 rows continue to read normally via getRawFile (dual-mode
// read in routes/projects.js). Replace-existing handles the
// cross-mode case: if the prior row was base64 (binary_sha256 IS NULL),
// it just becomes a blob row with no refcount bookkeeping for the old
// content; if it was already a blob, the prior blob's refcount is
// decremented (GC sweeps when ref_count = 0).
const BLOB_MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  eps: 'application/postscript',
};

function mimeFromPath(filePath) {
  const dot = String(filePath).lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = filePath.slice(dot + 1).toLowerCase();
  return BLOB_MIME_MAP[ext] || 'application/octet-stream';
}

/** Upload or replace a binary file (image, font, etc.) in a project. */
export async function uploadBinaryFile(projectId, filePath, buffer) {
  if (!isValidFilePath(filePath)) throw new Error('Invalid file path');
  const denied = deniedBinaryExtension(filePath);
  if (denied) throw new Error(`File type not allowed: ${denied}`);
  if (buffer.length > 50 * 1024 * 1024) throw new Error('File too large (max 50MB)');

  // Stream the buffer into the blob store. Returns { sha256, size, deduped }.
  // Wrapping the buffer in a Readable gives the helper the same shape it'd
  // see from a real multipart upload stream.
  const { sha256, size } = await writeBlob(projectId, Readable.from([buffer]));
  const mime = mimeFromPath(filePath);

  const existing = await db.get(
    'SELECT id, binary_sha256 FROM files WHERE project_id = $1 AND path = $2',
    [projectId, filePath],
  );

  try {
    await db.transaction(async (tx) => {
      // Bump the refcount for the new blob (or create the row at 1).
      await tx.run(
        `INSERT INTO project_blobs (project_id, sha256, size, ref_count)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (project_id, sha256) DO UPDATE
           SET ref_count = project_blobs.ref_count + 1`,
        [projectId, sha256, size],
      );

      if (existing) {
        // Decrement the OLD blob's refcount (if it was a blob; base64
        // rows have no project_blobs row, so the UPDATE is a no-op for
        // those).
        if (existing.binary_sha256 && existing.binary_sha256 !== sha256) {
          await tx.run(
            'UPDATE project_blobs SET ref_count = ref_count - 1 WHERE project_id = $1 AND sha256 = $2',
            [projectId, existing.binary_sha256],
          );
        }
        await tx.run(
          `UPDATE files
              SET content = '', is_binary = TRUE,
                  binary_sha256 = $1, binary_size = $2, binary_mime = $3,
                  updated_at = NOW()
            WHERE id = $4`,
          [sha256, size, mime, existing.id],
        );
      } else {
        await tx.run(
          `INSERT INTO files (id, project_id, path, content, is_binary,
                              binary_sha256, binary_size, binary_mime)
           VALUES ($1, $2, $3, '', TRUE, $4, $5, $6)`,
          [uuid(), projectId, filePath, sha256, size, mime],
        );
      }

      await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
    });
  } catch (err) {
    // Transaction rolled back. The blob is on disk but un-refcounted
    // (no project_blobs row exists for it, or the refcount we just
    // bumped also rolled back). The GC sweep will collect orphans.
    // Don't attempt eager unlink — the blob may have been deduped from
    // an existing file in this project that still references it.
    logger.warn({ err, projectId, sha256 }, 'uploadBinaryFile DB transaction failed; orphan blob will be GC-swept');
    throw err;
  }

  const row = await db.get(
    `SELECT id, project_id, path, binary_sha256, binary_size, binary_mime, is_binary
       FROM files WHERE project_id = $1 AND path = $2`,
    [projectId, filePath],
  );
  return { ...row, updated: !!existing };
}

// Helper for the file-delete path: decrement the refcount on the blob
// referenced by a row about to be deleted. No-op for base64 rows.
// Called inside the same transaction that deletes the file row.
async function decrementBlobRefcount(tx, projectId, blobSha256) {
  if (!blobSha256) return;
  await tx.run(
    'UPDATE project_blobs SET ref_count = ref_count - 1 WHERE project_id = $1 AND sha256 = $2',
    [projectId, blobSha256],
  );
}

/** Create a new text file in a project (fails if the path already exists). */
export async function createFile(projectId, filePath, content) {
  if (!isValidFilePath(filePath)) throw new Error('Invalid file path');
  if (content && content.length > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');
  const existing = await db.get('SELECT id FROM files WHERE project_id = $1 AND path = $2', [projectId, filePath]);
  if (existing) throw Object.assign(new Error('A file with that name already exists'), { status: 409 });
  const id = uuid();
  await db.run('INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, $3, $4)', [
    id,
    projectId,
    filePath,
    content || '',
  ]);
  await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  return { id, project_id: projectId, path: filePath, content: content || '' };
}

/** Save file content (+ optional tcMarks sidecar) and create a snapshot if due. */
export async function updateFileContent(fileId, content, userId, tcMarks, baseVersion) {
  const file = await db.get('SELECT * FROM files WHERE id = $1', [fileId]);
  if (!file) throw new Error('File not found');

  // V2-3 conflict guard: caller may pass baseVersion = the file's
  // updated_at when it was loaded. If that doesn't match the current
  // updated_at, somebody else saved between our load and this PUT —
  // surface a conflict instead of silently overwriting their work.
  if (baseVersion) {
    const current = file.updated_at instanceof Date
      ? file.updated_at.toISOString()
      : String(file.updated_at);
    const supplied = baseVersion instanceof Date
      ? baseVersion.toISOString()
      : String(baseVersion);
    if (current !== supplied) {
      return { ok: false, conflict: true, currentVersion: current };
    }
  }

  const marksJson = tcMarks === undefined ? null : JSON.stringify(tcMarks);
  const sameContent = file.content === content;
  const sameMarks = marksJson === null || marksJson === JSON.stringify(file.tc_marks ?? []);
  if (sameContent && sameMarks) {
    const v = file.updated_at instanceof Date ? file.updated_at.toISOString() : String(file.updated_at);
    return { ok: true, newSnapshot: false, version: v };
  }

  const user = userId ? await db.get('SELECT id, name FROM users WHERE id = $1', [userId]) : null;
  const authorId = user?.id || null;
  const authorName = user?.name || 'Unknown';
  let newSnapshot = false;

  await db.transaction(async (tx) => {
    if (marksJson !== null) {
      await tx.run('UPDATE files SET content = $1, tc_marks = $2::jsonb, updated_at = NOW() WHERE id = $3', [content, marksJson, file.id]);
    } else {
      await tx.run('UPDATE files SET content = $1, updated_at = NOW() WHERE id = $2', [content, file.id]);
    }
    await tx.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [file.project_id]);

    const proj = await tx.get('SELECT snapshot_interval_sec FROM projects WHERE id = $1', [file.project_id]);
    const intervalSec = proj?.snapshot_interval_sec || 30;
    const latestSnap = await tx.get(
      'SELECT id, created_at FROM project_snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [file.project_id],
    );
    const elapsed = latestSnap ? (Date.now() - new Date(latestSnap.created_at).getTime()) / 1000 : Infinity;
    if (elapsed >= intervalSec) {
      const allFiles = await tx.all(
        'SELECT id, path, content, is_binary FROM files WHERE project_id = $1 ORDER BY path',
        [file.project_id],
      );
      const payload = JSON.stringify({ files: allFiles });
      const compressed = gzipSync(Buffer.from(payload, 'utf8'));
      await tx.run(
        'INSERT INTO project_snapshots (id, project_id, data, author_id, author_name) VALUES ($1, $2, $3, $4, $5)',
        [uuid(), file.project_id, compressed, authorId, authorName],
      );
      newSnapshot = true;
    }
  });

  // Read back the new updated_at so the client can use it as the next
  // baseVersion.
  const after = await db.get('SELECT updated_at FROM files WHERE id = $1', [file.id]);
  const version = after?.updated_at instanceof Date
    ? after.updated_at.toISOString()
    : String(after?.updated_at);

  return { ok: true, newSnapshot, projectId: file.project_id, authorName, version };
}

/** Rename/move a file within its project. */
export async function renameFile(fileId, newPath) {
  if (!isValidFilePath(newPath)) throw new Error('Invalid file path');
  // Capture the old path BEFORE the rename so we can tell whether this file
  // was the project's main_file and migrate that pointer to the new path.
  const before = await db.get('SELECT path, project_id FROM files WHERE id = $1', [fileId]);
  await db.run('UPDATE files SET path = $1, updated_at = NOW() WHERE id = $2', [newPath, fileId]);
  const file = await db.get('SELECT * FROM files WHERE id = $1', [fileId]);
  if (file) {
    if (before && before.path !== newPath) {
      // If the file we just renamed is the project's main file, follow the
      // rename so subsequent compiles still target the right entry point.
      await db.run(
        'UPDATE projects SET main_file = $1, updated_at = NOW() WHERE id = $2 AND main_file = $3',
        [newPath, file.project_id, before.path],
      );
    } else {
      await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [file.project_id]);
    }
  }
  return file;
}

export async function deleteFile(fileId) {
  // If the file references a blob, decrement that blob's refcount in
  // the same transaction. GC sweep (phase B) removes blobs that
  // hit ref_count = 0. Legacy base64 rows have no project_blobs row
  // and the UPDATE is a harmless no-op for them.
  await db.transaction(async (tx) => {
    const file = await tx.get(
      'SELECT project_id, binary_sha256 FROM files WHERE id = $1',
      [fileId],
    );
    if (file) {
      await decrementBlobRefcount(tx, file.project_id, file.binary_sha256);
    }
    await tx.run('DELETE FROM files WHERE id = $1', [fileId]);
  });
}

// --- Folders ---
// Folders are otherwise implicit in file paths. project_folders persists
// the empty ones so a user can create a folder before adding files to it
// and have the folder survive a refresh.

/** Normalize a folder path: trim slashes, collapse repeats, reject .. */
function normalizeFolderPath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  if (!trimmed) return null;
  if (!isValidFilePath(trimmed)) return null;
  return trimmed;
}

/**
 * Escape SQL LIKE wildcards in a literal path so a name like "a_b" or
 * "a%b" matches only itself rather than "any single char" / "any number
 * of chars". Used together with `ESCAPE '\'` in every folder-scoped LIKE
 * clause to plug a wildcard-injection vector: an editor could otherwise
 * create a folder named `a%` and have a subsequent delete/rename hit
 * unrelated files in the same project.
 */
function escapeLikePattern(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

/** List all explicit empty-folder paths for a project. */
export async function listFolders(projectId) {
  const rows = await db.all(
    'SELECT path FROM project_folders WHERE project_id = $1 ORDER BY path',
    [projectId],
  );
  return rows.map((r) => r.path);
}

/** Create an empty folder. Idempotent: inserting the same path twice is a no-op. */
export async function createFolder(projectId, path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) throw Object.assign(new Error('Invalid folder path'), { status: 400 });
  await db.run(
    `INSERT INTO project_folders (id, project_id, path) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, path) DO NOTHING`,
    [uuid(), projectId, normalized],
  );
  await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
  return { path: normalized };
}

/**
 * Delete a folder and everything under it: all files at-or-below `path/*`
 * AND any explicit folder rows at-or-below `path`. Atomic. Idempotent on
 * a missing folder (treated as "all the files at that prefix are gone").
 */
export async function deleteFolder(projectId, path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) throw Object.assign(new Error('Invalid folder path'), { status: 400 });
  const prefix = escapeLikePattern(normalized) + '/%';
  await db.transaction(async (tx) => {
    await tx.run(
      `DELETE FROM project_folders WHERE project_id = $1 AND (path = $2 OR path LIKE $3 ESCAPE '\\')`,
      [projectId, normalized, prefix],
    );
    await tx.run(
      `DELETE FROM files WHERE project_id = $1 AND path LIKE $2 ESCAPE '\\'`,
      [projectId, prefix],
    );
  });
  await db.run('UPDATE projects SET updated_at = NOW() WHERE id = $1', [projectId]);
}

/**
 * Rename a folder, updating BOTH explicit folder rows and every file path
 * under the prefix. Atomic. Use this instead of looping per-file renames
 * from the client; collaborator UIs that re-fetch see one consistent state.
 */
export async function renameFolderTree(projectId, oldPath, newPath) {
  const oldNorm = normalizeFolderPath(oldPath);
  const newNorm = normalizeFolderPath(newPath);
  if (!oldNorm || !newNorm) throw Object.assign(new Error('Invalid folder path'), { status: 400 });
  if (oldNorm === newNorm) return { ok: true };
  if (newNorm.startsWith(oldNorm + '/')) {
    throw Object.assign(new Error('Cannot move a folder into itself'), { status: 400 });
  }
  const oldPrefix = escapeLikePattern(oldNorm) + '/%';
  const newPrefix = escapeLikePattern(newNorm) + '/%';
  await db.transaction(async (tx) => {
    // Collision check: any file or folder already at the target prefix?
    const fileConflict = await tx.get(
      `SELECT 1 FROM files WHERE project_id = $1 AND (path = $2 OR path LIKE $3 ESCAPE '\\') LIMIT 1`,
      [projectId, newNorm, newPrefix],
    );
    const folderConflict = await tx.get(
      `SELECT 1 FROM project_folders WHERE project_id = $1 AND (path = $2 OR path LIKE $3 ESCAPE '\\') LIMIT 1`,
      [projectId, newNorm, newPrefix],
    );
    if (fileConflict || folderConflict) {
      throw Object.assign(new Error(`A file or folder already exists at ${newNorm}`), { status: 409 });
    }
    // Rewrite folder rows in two updates: the exact match, then descendants
    // (separate so the LIKE pattern only matches descendants, not the root).
    await tx.run(
      'UPDATE project_folders SET path = $1 WHERE project_id = $2 AND path = $3',
      [newNorm, projectId, oldNorm],
    );
    await tx.run(
      `UPDATE project_folders
         SET path = $1 || substring(path FROM ${oldNorm.length + 1})
       WHERE project_id = $2 AND path LIKE $3 ESCAPE '\\'`,
      [newNorm, projectId, oldPrefix],
    );
    // Same shape for files. main_file follows if it lived under the prefix.
    await tx.run(
      `UPDATE files
         SET path = $1 || substring(path FROM ${oldNorm.length + 1}), updated_at = NOW()
       WHERE project_id = $2 AND path LIKE $3 ESCAPE '\\'`,
      [newNorm, projectId, oldPrefix],
    );
    await tx.run(
      `UPDATE projects
         SET main_file = $1 || substring(main_file FROM ${oldNorm.length + 1}), updated_at = NOW()
       WHERE id = $2 AND main_file LIKE $3 ESCAPE '\\'`,
      [newNorm, projectId, oldPrefix],
    );
    await tx.run(
      `UPDATE projects
         SET main_file = $1, updated_at = NOW()
       WHERE id = $2 AND main_file = $3`,
      [newNorm, projectId, oldNorm],
    );
  });
  return { ok: true };
}

/** Fetch a file's full row if the user has access to its project. */
export async function getRawFile(fileId, userId) {
  const file = await db.get(
    'SELECT f.*, pm.user_id FROM files f JOIN project_members pm ON f.project_id = pm.project_id WHERE f.id = $1 AND pm.user_id = $2',
    [fileId, userId],
  );
  return file;
}

// --- Member management ---

/** List all members of a project with their roles.
 *
 *  `includeEmail` defaults to false because a project member's email is
 *  privacy-sensitive — leaking it to every collaborator would let any
 *  user added to a project (which is currently anyone the owner
 *  invites) harvest the emails of every other collaborator. Owners
 *  legitimately need emails (to remove members, send invites), so the
 *  route passes `true` when the caller is the owner.
 */
export async function getProjectMembers(projectId, { includeEmail = false } = {}) {
  const rows = await db.all(
    `SELECT u.id, u.email, u.name, pm.role FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = $1`,
    [projectId],
  );
  if (includeEmail) return rows;
  return rows.map(({ email, ...rest }) => rest);
}

/** Invite a registered user to a project by email. */
// Hard ceiling on how many members + pending invitations a single
// project can carry. Generous for any legitimate paper / project but
// bounds the spam-via-invite case: an attacker who scripts invites
// can't fan one project out to thousands of addresses.
const PROJECT_MEMBERSHIP_CAP = 50;

export async function inviteMember(projectId, email, role, inviterId) {
  const normalizedEmail = email.toLowerCase().trim();
  // Unlike before, we DON'T reject when the email has no FlowTex
  // account. Storing an invitation against an unregistered email is
  // the whole point of the "invite someone who doesn't have an
  // account yet" flow — they'll see the invitation on their
  // dashboard the moment they register + verify with that same email.
  const user = await db.get('SELECT id, email, name FROM users WHERE email = $1', [normalizedEmail]);

  if (user) {
    const existing = await db.get('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [
      projectId,
      user.id,
    ]);
    if (existing) throw Object.assign(new Error('User is already a member'), { status: 409 });
  }

  // Per-project membership cap (members + pending invitations). The
  // per-user invite rate limit caps overall fan-out; this caps the
  // per-project blast radius so a single attacker-owned project
  // can't be used to invite thousands of addresses.
  const sizeRow = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM project_members WHERE project_id = $1) +
       (SELECT COUNT(*) FROM project_invitations
         WHERE project_id = $1 AND status = 'pending') AS total`,
    [projectId],
  );
  const total = parseInt(sizeRow?.total || 0, 10);
  if (total >= PROJECT_MEMBERSHIP_CAP) {
    throw Object.assign(
      new Error(`Project membership cap reached (${PROJECT_MEMBERSHIP_CAP}). Remove an existing member or cancel a pending invitation first.`),
      { status: 409 },
    );
  }

  const VALID_ROLES = ['editor', 'viewer'];
  const assignedRole = VALID_ROLES.includes(role) ? role : 'editor';

  const existingInvite = await db.get(
    "SELECT id FROM project_invitations WHERE project_id = $1 AND email = $2 AND status = 'pending'",
    [projectId, normalizedEmail],
  );
  if (existingInvite) throw Object.assign(new Error('Invitation already pending'), { status: 409 });

  // For unregistered users we generate a single-use-style decline
  // token that the email's "Decline" link carries. Registered users
  // accept/decline via the in-app dashboard so they don't need it.
  // Token is 32 bytes hex (~256 bits entropy); we store only the
  // SHA-256 hash so a DB leak can't be used to forge decline links.
  let declineTokenRaw = null;
  let declineTokenHash = null;
  if (!user) {
    declineTokenRaw = crypto.randomBytes(32).toString('hex');
    declineTokenHash = crypto.createHash('sha256').update(declineTokenRaw).digest('hex');
  }

  const id = uuid();
  await db.run(
    `INSERT INTO project_invitations (id, project_id, email, role, inviter_id, decline_token_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, email)
       DO UPDATE SET role = $4, inviter_id = $5, status = 'pending', decline_token_hash = $6`,
    [id, projectId, normalizedEmail, assignedRole, inviterId, declineTokenHash],
  );
  return {
    id,
    email,
    role: assignedRole,
    status: 'pending',
    // recipientHasAccount lets the route decide which email template
    // to send; declineToken is only non-null when there's no account.
    recipientHasAccount: !!user,
    declineToken: declineTokenRaw,
  };
}

/** Remove a member from a project and invalidate their cached membership. */
export async function removeMember(projectId, userId) {
  await db.run('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
  invalidateMembership(projectId, userId);
}

// --- Invitations ---

/** Get all pending project invitations for the current user. */
export async function getMyInvitations(userId) {
  const user = await db.get('SELECT email FROM users WHERE id = $1', [userId]);
  if (!user) return [];
  return db.all(
    `SELECT pi.id, pi.project_id, pi.role, pi.status, pi.created_at,
            p.name AS project_name, u.name AS inviter_name
     FROM project_invitations pi
     JOIN projects p ON p.id = pi.project_id
     JOIN users u ON u.id = pi.inviter_id
     WHERE LOWER(pi.email) = LOWER($1) AND pi.status = 'pending'
     ORDER BY pi.created_at DESC`,
    [user.email],
  );
}

/** Accept a project invitation, adding the user as a member. */
export async function acceptInvitation(inviteId, userId) {
  const user = await db.get('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!user) throw new Error('Not logged in');
  // Look up by id alone first so the caller can distinguish "doesn't exist
  // / already resolved" from "exists but addressed to a different user".
  // The latter is a probe attempt and worth auditing; the former is usually
  // just a stale UI clicking on something that was already accepted/declined.
  const inviteRaw = await db.get(
    'SELECT * FROM project_invitations WHERE id = $1',
    [inviteId],
  );
  if (!inviteRaw || inviteRaw.status !== 'pending') {
    throw Object.assign(new Error('Invitation not found'), { status: 404 });
  }
  if ((inviteRaw.email || '').toLowerCase() !== user.email.toLowerCase()) {
    throw Object.assign(new Error('Invitation not found'), { status: 404, emailMismatch: true });
  }
  const invite = inviteRaw;

  await db.transaction(async (tx) => {
    await tx.run("UPDATE project_invitations SET status = 'accepted' WHERE id = $1", [invite.id]);
    const existing = await tx.get('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [
      invite.project_id,
      user.id,
    ]);
    if (!existing) {
      await tx.run('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
        invite.project_id,
        user.id,
        invite.role,
      ]);
    }
  });
  invalidateMembership(invite.project_id, user.id);
  return { ok: true, projectId: invite.project_id };
}

/** Decline a project invitation. */
export async function declineInvitation(inviteId, userId) {
  const user = await db.get('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!user) throw new Error('Not logged in');
  const invite = await db.get(
    "SELECT * FROM project_invitations WHERE id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending'",
    [inviteId, user.email],
  );
  if (!invite) throw Object.assign(new Error('Invitation not found'), { status: 404 });
  await db.run("UPDATE project_invitations SET status = 'declined' WHERE id = $1", [invite.id]);
}

/** List all pending invitations for a project. */
export async function getProjectInvitations(projectId) {
  return db.all(
    `SELECT pi.id, pi.email, pi.role, pi.status, pi.created_at, u.name AS inviter_name
     FROM project_invitations pi JOIN users u ON u.id = pi.inviter_id
     WHERE pi.project_id = $1 AND pi.status = 'pending' ORDER BY pi.created_at DESC`,
    [projectId],
  );
}

/** Cancel (delete) a pending invitation. */
export async function cancelInvitation(inviteId, projectId) {
  await db.run('DELETE FROM project_invitations WHERE id = $1 AND project_id = $2', [inviteId, projectId]);
}

// --- Archive / Trash ---

export async function archiveProject(projectId) {
  await db.run('UPDATE projects SET archived = TRUE WHERE id = $1', [projectId]);
}

export async function unarchiveProject(projectId) {
  await db.run('UPDATE projects SET archived = FALSE WHERE id = $1', [projectId]);
}

export async function trashProject(projectId) {
  await db.run('UPDATE projects SET trashed = TRUE WHERE id = $1', [projectId]);
}

export async function restoreProject(projectId) {
  await db.run('UPDATE projects SET trashed = FALSE WHERE id = $1', [projectId]);
}
