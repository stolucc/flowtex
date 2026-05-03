#!/usr/bin/env node
// Generate PNG thumbnails for each project template
// Usage: node scripts/generate-thumbnails.mjs

import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Import templates
const { default: TEMPLATES } = await import(join(ROOT, 'server/utils/templates.js'));

const OUT_DIR = join(ROOT, 'server/public/thumbnails');
const TMP_DIR = join(ROOT, '.tmp-thumbs');

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

for (const tmpl of TEMPLATES) {
  console.log(`Compiling ${tmpl.id}...`);
  const workDir = join(TMP_DIR, tmpl.id);
  mkdirSync(workDir, { recursive: true });

  // Write all template files
  for (const f of tmpl.files) {
    const filePath = join(workDir, f.path);
    mkdirSync(dirname(filePath), { recursive: true });
    const content = f.content
      .replace(/__TITLE__/g, 'Sample Title')
      .replace(/__AUTHOR__/g, 'Jane Doe');
    writeFileSync(filePath, content);
  }

  // Compile with pdflatex (two passes for TOC etc.)
  const mainTex = join(workDir, 'main.tex');
  try {
    for (let pass = 0; pass < 2; pass++) {
      execFileSync('pdflatex', [
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-output-directory', workDir,
        mainTex,
      ], { timeout: 30000, stdio: 'pipe' });
    }
  } catch {
    // Some templates (acm, ieee) may fail without class files — try once
    console.warn(`  Warning: ${tmpl.id} compile had issues, checking for PDF...`);
  }

  const pdfPath = join(workDir, 'main.pdf');
  if (!existsSync(pdfPath)) {
    console.warn(`  Skipping ${tmpl.id} — no PDF generated`);
    continue;
  }

  // Convert first page to PNG thumbnail (200 DPI, then we'll have a decent size)
  const ppmPrefix = join(workDir, 'thumb');
  try {
    execFileSync('pdftoppm', [
      '-png', '-f', '1', '-l', '1', '-r', '150',
      pdfPath, ppmPrefix,
    ], { timeout: 10000, stdio: 'pipe' });
  } catch {
    console.warn(`  Failed to convert ${tmpl.id} PDF to PNG`);
    continue;
  }

  // pdftoppm outputs thumb-1.png or thumb-01.png
  const candidates = ['thumb-1.png', 'thumb-01.png', 'thumb-001.png'];
  let pngSrc = null;
  for (const c of candidates) {
    const p = join(workDir, c);
    if (existsSync(p)) { pngSrc = p; break; }
  }

  if (pngSrc) {
    const dest = join(OUT_DIR, `${tmpl.id}.png`);
    const data = readFileSync(pngSrc);
    writeFileSync(dest, data);
    console.log(`  -> ${dest} (${Math.round(data.length / 1024)}KB)`);
  } else {
    console.warn(`  No PNG output found for ${tmpl.id}`);
  }
}

// Clean up
rmSync(TMP_DIR, { recursive: true, force: true });
console.log('Done!');
