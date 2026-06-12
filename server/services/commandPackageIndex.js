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
 * "preferred" one. Heuristics, in priority order:
 *
 *   1. Strongest demotion: packages that are `\input`ed by another
 *      package in the index. These are internal/backend files (e.g.
 *      `soul-ori`, which the user never loads -- they load `soul`).
 *   2. Demotion: suffix matches like `*-tools`, `*-internal`, `*-base`,
 *      `*-kernel` -- conventional implementation-package names.
 *   3. Boost: package name shares a prefix with the command (so
 *      \tikzset -> tikz, not some unrelated pkg that exports tikzset).
 *   4. Tie-break: shorter name beats longer (so `amsmath` > `amsmath2`).
 *
 * @param {string} cmd
 * @param {Set<string>} candidates
 * @param {Set<string>} [internalPkgs] - packages that are inputs of others
 * @returns {string}
 */
export function pickPreferredPackage(cmd, candidates, internalPkgs) {
  if (candidates.size === 1) return [...candidates][0];
  const internals = internalPkgs ?? new Set();
  const arr = [...candidates];
  arr.sort((a, b) => {
    // (1) Strongest demote: package is an internal/backend file.
    const aInternal = internals.has(a) ? 1 : 0;
    const bInternal = internals.has(b) ? 1 : 0;
    if (aInternal !== bInternal) return aInternal - bInternal;
    // (2) Suffix-shape demote.
    const aDemote = /(tools|internal|base|kernel|utils?|ori)$/.test(a) ? 1 : 0;
    const bDemote = /(tools|internal|base|kernel|utils?|ori)$/.test(b) ? 1 : 0;
    if (aDemote !== bDemote) return aDemote - bDemote;
    // (3) Prefix-match boost.
    const aPrefix = cmd.toLowerCase().startsWith(a.toLowerCase()) ? 1 : 0;
    const bPrefix = cmd.toLowerCase().startsWith(b.toLowerCase()) ? 1 : 0;
    if (aPrefix !== bPrefix) return bPrefix - aPrefix;
    // (4) Tie-break on shorter name.
    return a.length - b.length;
  });
  return arr[0];
}

/**
 * Extract the names of .sty (or .tex) files this file `\input`s,
 * `\RequirePackage`s, `\LoadPackage`s, or `\usepackage`s.
 *
 * Used to build the inclusion graph so a command defined in
 * `soul-ori.sty` correctly resolves to the user-facing package `soul`
 * (which `\input`s soul-ori).
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractInputs(content) {
  /** @type {Set<string>} */
  const out = new Set();
  // Strip comments first (same logic as extractCommandsFromStyContent).
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

  const patterns = [
    // \input soul-ori.sty   /   \input{soul-ori.sty}   /   \input{soul-ori}
    // The unbraced form stops at the next whitespace, %, OR backslash
    // (the latter so `\input soul-ori.sty\relax` is parsed correctly).
    /\\input\s*(?:\{([^}]+)\}|([^\s{}\\][^\s%\\]*))/g,
    // \RequirePackage{X} / \RequirePackage[opts]{X}
    /\\RequirePackage(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g,
    // \LoadPackage{X}
    /\\LoadPackage(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g,
    // \usepackage{X} - rare in .sty files but used in some bundles
    /\\usepackage(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g,
  ];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(stripped)) !== null) {
      const arg = (m[1] || m[2] || '').trim();
      if (!arg) continue;
      // Multiple packages can be comma-separated.
      for (const raw of arg.split(',')) {
        let name = raw.trim().replace(/\.(sty|tex|cls|def|cfg)$/i, '');
        // Reject paths/relative refs we can't resolve confidently.
        if (!name || /[/\\]/.test(name)) continue;
        // Reject names that aren't plausible package names.
        if (!/^[a-zA-Z][a-zA-Z0-9@.-]*$/.test(name)) continue;
        out.add(name);
      }
    }
  }
  return out;
}

/**
 * Build a command-package map from a list of { path, content } records.
 *
 * Algorithm:
 *   1. For each file F, extract the set of commands it defines AND
 *      the set of other files it `\input`s / `\RequirePackage`s.
 *   2. Walk the inclusion graph: when file A inputs file B, any
 *      command defined in B also lives in A's user-facing package
 *      (because `\usepackage{A}` triggers loading B).
 *   3. For each command, pick the canonical package using
 *      pickPreferredPackage, which now also demotes "internal-looking"
 *      package names (those that are `\input`ed by another file in the
 *      index).
 *
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Map<string, string>}
 */
export function buildIndexFromFileContents(files) {
  /** @type {Map<string, { cmds: Set<string>, inputs: Set<string> }>} */
  const perFile = new Map();
  for (const file of files) {
    const pkg = styPathToPackageName(file.path);
    if (perFile.has(pkg)) continue; // dup .sty (rare; first wins)
    perFile.set(pkg, {
      cmds: extractCommandsFromStyContent(file.content),
      inputs: extractInputs(file.content),
    });
  }

  // Identify "internal" packages: any package that is `\input`ed by
  // another package in the index. The user can't load these directly
  // via `\usepackage{}` -- they're loaded transitively. Demote them
  // in the canonical-package picker.
  /** @type {Set<string>} */
  const internalPkgs = new Set();
  for (const [, entry] of perFile.entries()) {
    for (const input of entry.inputs) {
      if (perFile.has(input)) internalPkgs.add(input);
    }
  }

  // Build the cmd -> set<pkg> map, walking the inclusion graph so a
  // command defined in an internal file also lives in any wrapper
  // that inputs it. Use a transitive-closure walk with a depth cap to
  // bound pathological cases.
  /** @type {Map<string, Set<string>>} */
  const cmdToPkgs = new Map();
  /** @param {string} pkg @param {Set<string>} pkgsSeen @returns {Set<string>} */
  function transitiveInputs(pkg, pkgsSeen) {
    /** @type {Set<string>} */
    const out = new Set();
    if (pkgsSeen.has(pkg) || pkgsSeen.size > 50) return out;
    pkgsSeen.add(pkg);
    const entry = perFile.get(pkg);
    if (!entry) return out;
    for (const child of entry.inputs) {
      if (!perFile.has(child)) continue;
      out.add(child);
      for (const grandchild of transitiveInputs(child, pkgsSeen)) out.add(grandchild);
    }
    return out;
  }

  for (const [pkg, entry] of perFile.entries()) {
    // The package's "own" commands -- defined in its own .sty.
    for (const cmd of entry.cmds) {
      let set = cmdToPkgs.get(cmd);
      if (!set) {
        set = new Set();
        cmdToPkgs.set(cmd, set);
      }
      set.add(pkg);
    }
    // Plus commands from transitively-input packages.
    for (const child of transitiveInputs(pkg, new Set())) {
      const childEntry = perFile.get(child);
      if (!childEntry) continue;
      for (const cmd of childEntry.cmds) {
        let set = cmdToPkgs.get(cmd);
        if (!set) {
          set = new Set();
          cmdToPkgs.set(cmd, set);
        }
        set.add(pkg);
      }
    }
  }

  /** @type {Map<string, string>} */
  const result = new Map();
  for (const [cmd, pkgs] of cmdToPkgs.entries()) {
    result.set(cmd, pickPreferredPackage(cmd, pkgs, internalPkgs));
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
 * an array of roots; the indexer walks each one underneath.
 *
 * Vars consulted: TEXMFDIST (vendor), TEXMFLOCAL (admin-installed),
 * TEXMFHOME (per-user). Under each, BOTH `tex/latex/` (LaTeX-only)
 * AND `tex/generic/` (works in LaTeX too -- e.g. soul, xcolor) are
 * walked. Without `tex/generic/`, packages like soul are completely
 * missed because their .sty files live there.
 *
 * Missing vars and missing subdirs are silently skipped.
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
      if (!dir) continue;
      for (const sub of ['latex', 'generic']) {
        const styDir = path.join(dir, 'tex', sub);
        try {
          await stat(styDir);
          roots.push(styDir);
        } catch { /* dir doesn't exist */ }
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
