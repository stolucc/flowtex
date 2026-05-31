/* global console */
// Renders markdown docs from the repo root into styled HTML pages
// inside client/public/docs/ so they ship in the Vite dist/ bundle
// and the running FlowTex server can serve them at /docs/<name>.html.
// The Help menu links to each.
//
// Currently builds:
//   USER_GUIDE.md   → /docs/user-guide.html      ("User guide")
//   HELPER_GUIDE.md → /docs/helper-guide.html    ("Helper setup guide")
//
// Run automatically as `npm run prebuild` (and so on every `npm run
// build`). Safe to re-run; output is deterministic for a given
// source file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const destDir = path.resolve(here, '..', 'public', 'docs');

// Source markdown → output HTML mapping. `sidebarTitle` is what
// appears at the top of the left-hand sidebar; `pageTitle` is the
// browser <title>; `banner` is the small note at the top of the
// main column (auto-generated reminder + sibling-doc cross-link).
const DOCS = [
  {
    src: 'USER_GUIDE.md',
    out: 'user-guide.html',
    sidebarTitle: 'User guide',
    pageTitle: 'FlowTex — User Guide',
    banner:
      'This page is auto-generated from <code>USER_GUIDE.md</code> in the source repository. ' +
      'For the helper-specific setup, see the <a href="/docs/helper-guide.html">Helper setup guide</a>.',
  },
  {
    src: 'HELPER_GUIDE.md',
    out: 'helper-guide.html',
    sidebarTitle: 'Helper setup',
    pageTitle: 'FlowTex — Helper Setup Guide',
    banner:
      'This page is auto-generated from <code>HELPER_GUIDE.md</code> in the source repository. ' +
      'For the rest of the FlowTex app, see the <a href="/docs/user-guide.html">User guide</a>.',
  },
];

// Disable mangling of email addresses (we don't have any but the
// defaults flag is moving) and let GFM extensions through so tables
// + task lists render.
marked.setOptions({ gfm: true, breaks: false });

/** Build a sidebar table-of-contents from the H2 headings in the
 *  rendered HTML. Each h2 gets an anchor id we add ourselves; the
 *  sidebar links to those. */
function buildToc(html) {
  const re = /<h2>([^<]+)<\/h2>/g;
  const items = [];
  let m;
  let idx = 0;
  let out = html;
  while ((m = re.exec(html))) {
    const title = m[1];
    const id = `s${idx++}-` + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    items.push({ id, title });
    // Replace the FIRST occurrence (in order) of this exact heading with
    // an id-bearing version. Using a positional walk to avoid races.
    out = out.replace(`<h2>${title}</h2>`, `<h2 id="${id}">${title}</h2>`);
  }
  const sidebar = items.map((i) => `<li><a href="#${i.id}">${i.title}</a></li>`).join('\n');
  return { html: out, sidebar };
}

function template({ body, sidebar, sidebarTitle, pageTitle, banner }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle}</title>
<style>
  :root { --bg: #f8f9fa; --fg: #1a1a2e; --accent: #2563eb; --border: #d1d5db; --surface: #fff; --code-bg: #f1f3f5; --muted: #6b7280; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.65; display: flex; min-height: 100vh; }
  nav.toc { width: 260px; background: var(--surface); border-right: 1px solid var(--border); padding: 24px 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; flex-shrink: 0; }
  nav.toc h1 { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 12px; }
  nav.toc ul { list-style: none; }
  nav.toc li { margin-bottom: 4px; }
  nav.toc a { color: var(--fg); text-decoration: none; font-size: 0.9rem; display: block; padding: 4px 8px; border-radius: 4px; }
  nav.toc a:hover { background: var(--code-bg); }
  main { max-width: 820px; padding: 2.5rem 2.5rem 4rem; flex: 1; }
  main h1 { font-size: 1.9rem; margin-bottom: 1.5rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--accent); }
  main h2 { font-size: 1.35rem; margin-top: 2.2rem; margin-bottom: 0.6rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
  main h3 { font-size: 1.1rem; margin-top: 1.4rem; margin-bottom: 0.4rem; }
  main h4 { font-size: 1rem; margin-top: 1.1rem; margin-bottom: 0.3rem; }
  p, li { margin-bottom: 0.55rem; }
  ul, ol { padding-left: 1.6rem; margin-bottom: 0.8rem; }
  code { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 0.88em; background: var(--code-bg); padding: 0.12em 0.4em; border-radius: 3px; }
  pre { background: #1e293b; color: #e2e8f0; padding: 1rem 1.2rem; border-radius: 6px; overflow-x: auto; margin: 0.8rem 0 1.2rem; line-height: 1.5; }
  pre code { background: none; color: inherit; padding: 0; font-size: 0.85em; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2.2rem 0; }
  a { color: var(--accent); }
  blockquote { border-left: 4px solid var(--accent); padding: 0.6rem 1rem; margin: 1rem 0; background: var(--surface); color: var(--muted); border-radius: 0 4px 4px 0; }
  table { border-collapse: collapse; margin: 0.8rem 0 1.2rem; font-size: 0.92em; }
  th, td { border: 1px solid var(--border); padding: 0.45rem 0.7rem; text-align: left; }
  th { background: var(--code-bg); font-weight: 600; }
  .helper-banner { font-size: 0.85rem; color: var(--muted); padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 24px; }
  .helper-banner a { color: var(--accent); }
  @media (max-width: 900px) {
    body { flex-direction: column; }
    nav.toc { position: static; height: auto; width: 100%; border-right: 0; border-bottom: 1px solid var(--border); }
    main { padding: 1.5rem; }
  }
</style>
</head>
<body>
<nav class="toc">
  <h1>${sidebarTitle}</h1>
  <ul>
${sidebar}
  </ul>
  <p style="margin-top:24px;font-size:0.8rem;color:var(--muted);">
    ← <a href="/">Back to FlowTex</a>
  </p>
</nav>
<main>
  <div class="helper-banner">${banner}</div>
${body}
</main>
</body>
</html>
`;
}

await fs.mkdir(destDir, { recursive: true });
for (const doc of DOCS) {
  const srcPath = path.join(repoRoot, doc.src);
  const destPath = path.join(destDir, doc.out);
  const md = await fs.readFile(srcPath, 'utf-8');
  const rawHtml = marked.parse(md);
  const { html, sidebar } = buildToc(rawHtml);
  await fs.writeFile(destPath, template({
    body: html,
    sidebar,
    sidebarTitle: doc.sidebarTitle,
    pageTitle: doc.pageTitle,
    banner: doc.banner,
  }), 'utf-8');
  console.log(`build-docs: ${doc.src} → ${destPath} (${html.length.toLocaleString()} chars HTML + ${sidebar.split('\n').length} TOC entries)`);
}
