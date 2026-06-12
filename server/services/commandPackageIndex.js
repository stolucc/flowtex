// @ts-check
//
// Command -> package index built from the installed TeX Live tree.
//
// Powers the client's "Add \usepackage{X}" quick-fix for arbitrary
// undefined commands -- not just the ~90 hand-curated entries on the
// client. For a self-hosted FlowTex deploy with a full TeX Live, this
// covers the entire CTAN command surface that the local installation
// actually has.
//
// Strategy:
//   1. Discover .sty files via `kpsewhich -var-value TEXMFDIST` (and
//      TEXMFLOCAL), then walk `<root>/tex/latex/` for *.sty.
//   2. For each .sty, scan for command-definition patterns:
//        \newcommand{\X}{...}      \newcommand\X{...}
//        \renewcommand{\X}{...}    \providecommand{\X}{...}
//        \NewDocumentCommand{\X}{...}{...}
//        \DeclareRobustCommand{\X}{...}
//        \def\X{...}               \let\X=\Y
//      The package name is the .sty filename without extension.
//   3. Build Map<command, packageName>. When the same command is
//      defined in multiple packages, prefer the one whose package
//      name matches a common preferred-namespace shape (see
//      pickPreferredPackage).
//
// The index is built lazily on the first request and cached
// in-memory. Reset every REINDEX_INTERVAL_MS; or via the explicit
// rebuild() helper for tests.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REINDEX_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ─── Pure-logic helpers (testable without disk) ──────────────────────

/**
 * Regex source for "matches a backslash + identifier" where the
 * identifier is captured. Allows a single optional `{` between the
 * backslash and the identifier (for `\newcommand{\X}` shape).
 */
const CMD_CAP = '\\\\?(\\w+)';

/**
 * Definition patterns to scan for in .sty files. Each pattern's first
 * capture group is the command name (no leading backslash).
 */
const CMD_DEF_PATTERNS = [
  // \newcommand{\X}, \renewcommand{\X}, \providecommand{\X}
  new RegExp(`\\\\(?:new|renew|provide)command\\s*\\{\\s*\\\\(\\w+)\\s*\\}`, 'g'),
  // \newcommand\X, \renewcommand\X, \providecommand\X
  new RegExp(`\\\\(?:new|renew|provide)command\\s*\\\\(\\w+)`, 'g'),
  // \NewDocumentCommand{\X}, \DeclareDocumentCommand{\X}
  new RegExp(`\\\\(?:New|Declare)DocumentCommand\\s*\\{\\s*\\\\(\\w+)\\s*\\}`, 'g'),
  // \DeclareRobustCommand{\X}, \ProvideRobustCommand{\X}
  new RegExp(`\\\\(?:Declare|Provide)RobustCommand\\s*\\{?\\s*\\\\(\\w+)`, 'g'),
  // \newenvironment{name} -- environments are useful too
  new RegExp(`\\\\(?:new|renew)environment\\s*\\{\\s*(\\w+)\\s*\\}`, 'g'),
  // \def\X
  new RegExp(`\\\\(?:long\\s+)?(?:e?global\\s+)?def\\s*\\\\(\\w+)`, 'g'),
  // \let\X (only when followed by `=` or `\` to avoid \let alone)
  new RegExp(`\\\\let\\s*\\\\(\\w+)\\s*(?:=|\\\\)`, 'g'),
];

void CMD_CAP; // kept above for documentation; expanded inline in the regexes

/**
 * Extract the set of commands defined inside a single .sty file's
 * source. Returns command names without the leading backslash.
 *
 * Strips:
 *   - LaTeX comments (% ... to end-of-line, unescaped %)
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractCommandsFromStyContent(content) {
  // Strip comments: a % that is NOT preceded by a \ marks a comment
  // through end-of-line. The escape can be empirically `\\%` (a
  // literal percent sign) which we must NOT strip.
  const stripped = content
    .split('\n')
    .map((line) => {
      let i = 0;
      while (i < line.length) {
        if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
          return line.slice(0, i);
        }
        i++;
      }
      return line;
    })
    .join('\n');

  /** @type {Set<string>} */
  const cmds = new Set();
  for (const pattern of CMD_DEF_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(stripped)) !== null) {
      const name = m[1];
      // Filter out single-character internal names that are mostly
      // noise (\@, \i, etc.) and the helpers that start with @
      // (LaTeX-internal namespace).
      if (!name) continue;
      if (name.length === 1) continue;
      if (name.startsWith('@')) continue;
      cmds.add(name);
    }
  }
  return cmds;
}

/**
 * Convert a .sty file path to its package name (basename without
 * extension). Used as the canonical mapping target.
 *
 * @param {string} styPath
 * @returns {string}
 */
export function styPathToPackageName(styPath) {
  const base = path.basename(styPath);
  return base.replace(/\.sty$/i, '');
}

/**
 * When the same command is defined in multiple packages, pick the
 * "preferred" one. Heuristic: shorter package names usually beat
 * longer ones (e.g., `amsmath` beats `amsmath-light`); names matching
 * the command's prefix beat unrelated names (e.g., `tikz-*` for
 * commands starting with `tikz`); and built-in LaTeX classes (`*.cls`
 * disguised as `.sty`) are deprioritised.
 *
 * @param {string} cmd
 * @param {Set<string>} candidates
 * @returns {string}
 */
export function pickPreferredPackage(cmd, candidates) {
  if (candidates.size === 1) return [...candidates][0];
  const arr = [...candidates];
  arr.sort((a, b) => {
    // Lower priority: package names matching `*-tools`, `*-internal`,
    // or `*-base` which are usually implementation packages.
    const aDemote = /(tools|internal|base|kernel|utils?)$/.test(a) ? 1 : 0;
    const bDemote = /(tools|internal|base|kernel|utils?)$/.test(b) ? 1 : 0;
    if (aDemote !== bDemote) return aDemote - bDemote;
    // Higher priority: package name shares a prefix with the command.
    const aPrefix = cmd.toLowerCase().startsWith(a.toLowerCase()) ? 1 : 0;
    const bPrefix = cmd.toLowerCase().startsWith(b.toLowerCase()) ? 1 : 0;
    if (aPrefix !== bPrefix) return bPrefix - aPrefix;
    // Tie-break: shorter name beats longer.
    return a.length - b.length;
  });
  return arr[0];
}

/**
 * Build a command-package map from a list of { path, content } records.
 * Pure function for testability.
 *
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Map<string, string>}
 */
export function buildIndexFromFileContents(files) {
  /** @type {Map<string, Set<string>>} */
  const cmdToPkgs = new Map();
  for (const file of files) {
    const pkg = styPathToPackageName(file.path);
    const cmds = extractCommandsFromStyContent(file.content);
    for (const cmd of cmds) {
      let set = cmdToPkgs.get(cmd);
      if (!set) {
        set = new Set();
        cmdToPkgs.set(cmd, set);
      }
      set.add(pkg);
    }
  }
  /** @type {Map<string, string>} */
  const result = new Map();
  for (const [cmd, pkgs] of cmdToPkgs.entries()) {
    result.set(cmd, pickPreferredPackage(cmd, pkgs));
  }
  return result;
}

// ─── Disk discovery (less testable; mocked by callers) ───────────────

/**
 * Walk a directory recursively and return absolute paths of all files
 * matching `predicate`. Used to find .sty files under TEXMFDIST.
 *
 * @param {string} root
 * @param {(p: string) => boolean} predicate
 * @returns {Promise<string[]>}
 */
export async function walkDir(root, predicate) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && predicate(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Discover the TeX paths that hold .sty files via kpsewhich. Returns
 * an array of roots; the indexer walks `<root>/tex/latex/` underneath.
 *
 * Vars consulted: TEXMFDIST (vendor), TEXMFLOCAL (admin-installed),
 * TEXMFHOME (per-user). Missing vars are silently skipped.
 *
 * @returns {Promise<string[]>}
 */
export async function discoverTexRoots() {
  /** @type {string[]} */
  const roots = [];
  for (const varName of ['TEXMFDIST', 'TEXMFLOCAL', 'TEXMFHOME']) {
    try {
      const { stdout } = await execFileAsync('kpsewhich', ['-var-value', varName], { timeout: 5000 });
      const dir = stdout.trim();
      if (dir) {
        const styDir = path.join(dir, 'tex', 'latex');
        try {
          await stat(styDir);
          roots.push(styDir);
        } catch { /* dir doesn't exist (e.g. empty TEXMFHOME) */ }
      }
    } catch {
      // kpsewhich missing / errored. Caller decides whether to fall
      // back to an empty index.
    }
  }
  return roots;
}

/**
 * Build the index by walking the TeX roots, reading every .sty, and
 * pure-merging via buildIndexFromFileContents.
 *
 * @returns {Promise<Map<string, string>>}
 */
export async function buildIndex() {
  const roots = await discoverTexRoots();
  /** @type {string[]} */
  const allStys = [];
  for (const root of roots) {
    const files = await walkDir(root, (p) => p.endsWith('.sty'));
    allStys.push(...files);
  }
  // Read in batches to bound memory; the .sty corpus is ~25 MB total
  // for a full TL but loading all at once is fine on a server.
  /** @type {Array<{ path: string, content: string }>} */
  const records = [];
  await Promise.all(
    allStys.map(async (p) => {
      try {
        const content = await readFile(p, 'utf8');
        records.push({ path: p, content });
      } catch {
        // Skip unreadable files (permissions, exotic encodings).
      }
    }),
  );
  return buildIndexFromFileContents(records);
}

// ─── Lazy in-memory cache + reset for tests ──────────────────────────

/** @type {{ map: Map<string, string>, builtAt: number } | null} */
let cache = null;
/** @type {Promise<Map<string, string>> | null} */
let inFlight = null;

/**
 * Get the index, building it on the first call and reusing the cache
 * thereafter. Re-builds after REINDEX_INTERVAL_MS so newly-installed
 * packages get picked up without a restart.
 */
export async function getIndex() {
  const now = Date.now();
  if (cache && now - cache.builtAt < REINDEX_INTERVAL_MS) return cache.map;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const map = await buildIndex();
      cache = { map, builtAt: Date.now() };
      return map;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Reset the index cache. Used by tests and by an operator who has
 * just installed new packages and doesn't want to wait 24 hours.
 */
export function resetIndexCache() {
  cache = null;
  inFlight = null;
}

/**
 * Look up a single command's package. Returns null when not found.
 *
 * @param {string} cmd - command name WITHOUT leading backslash
 * @returns {Promise<string | null>}
 */
export async function lookupCommandPackage(cmd) {
  if (!cmd || typeof cmd !== 'string') return null;
  const map = await getIndex();
  return map.get(cmd) || null;
}
