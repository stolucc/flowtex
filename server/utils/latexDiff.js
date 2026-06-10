// @ts-check
/**
 * LaTeX diff — shells out to the real `latexdiff` binary from TeX Live.
 *
 * latexdiff is a mature Perl tool (20+ years) that handles:
 * - LaTeX-aware tokenization (\cite[p. 1]{ref} as one token)
 * - Safe command lists (hundreds of commands known to be fragile)
 * - Float-safe macro variants (\DIFaddFL / \DIFdelFL)
 * - Moving argument protection via \protect and \texorpdfstring
 * - Table and math mode awareness
 *
 * We write temp files, run latexdiff, and return the output.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

// TeX Live paths (same as compiler.js)
const TEX_PATHS = [
  '/Library/TeX/texbin',
  '/usr/local/texlive/2025/bin/universal-darwin',
  '/usr/local/bin',
  '/opt/local/bin',
].join(':');

/**
 * Generate a LaTeX diff document using the system latexdiff binary.
 *
 * @param {string} oldTex - Content of the old .tex file
 * @param {string} newTex - Content of the new .tex file
 * @param {object} [options] - Options
 * @param {string} [options.workDir] - Working directory (for resolving \input etc.)
 * @returns {Promise<string>} The diff .tex content
 */
/**
 * Post-process latexdiff output to fix known issues.
 *
 * latexdiff inserts \DIFaddendFL, \DIFaddbeginFL etc. markers that use
 * \noalign internally. When these appear on the same line as \toprule,
 * \midrule, \bottomrule, \caption, \addlinespace, or \endhead (which
 * also use \noalign), LaTeX throws "Misplaced \noalign" errors.
 *
 * Fix: strip DIF markers from lines containing these table commands.
 */
/** @param {string} tex */
export function postProcess(tex) {
  // Commands that use \noalign and break when DIF markers are nearby
  const noalignCmds = /\\(toprule|midrule|bottomrule|addlinespace|caption|endhead|endfirsthead|endfoot|endlastfoot)\b/;
  // Commands that use \omit
  const omitCmds = /\\(multicolumn|multirow)\b/;

  /** @param {string} s */
  function stripDif(s) {
    // Preserve a one-character word boundary across the strip: if there's
    // whitespace on either side of the marker, keep one space so adjacent
    // tokens don't run together. The previous form `…\s*` greedily ate the
    // marker's trailing whitespace, which collapsed `prefix\DIFaddbegin foo`
    // into `prefixfoo`.
    return s
      .replace(
        /(\s)?\\DIF(add|del)(begin|end)(FL)?(\s)?/g,
        (/** @type {string} */ _m, /** @type {string|undefined} */ leading, /** @type {string} */ _a, /** @type {string} */ _b, /** @type {string|undefined} */ _fl, /** @type {string|undefined} */ trailing) =>
          leading || trailing ? ' ' : '',
      )
      .replace(
        /(\s)?\\DIF(add|del)FL\{[^}]*\}(\s)?/g,
        (/** @type {string} */ _m, /** @type {string|undefined} */ leading, /** @type {string} */ _a, /** @type {string|undefined} */ trailing) =>
          leading || trailing ? ' ' : '',
      );
  }

  /** @param {string} s */
  function hasDif(s) {
    return /\\DIF(add|del)(begin|end)(FL)?/.test(s);
  }

  // Look ahead from line i past blank lines to find first non-blank line
  /**
   * @param {string[]} lines
   * @param {number} i
   */
  function nextNonBlank(lines, i) {
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      if (lines[j].trim() !== '') return lines[j];
    }
    return null;
  }

  const lines = tex.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Strip DIF markers from lines with \noalign or \omit commands
    if (noalignCmds.test(line) || omitCmds.test(line)) {
      line = stripDif(line);
    }

    // If this line has DIF markers and the next non-blank line has \noalign cmds,
    // strip them (or skip the line entirely if it's only a DIF marker)
    if (hasDif(line)) {
      const next = nextNonBlank(lines, i);
      if (next && noalignCmds.test(next)) {
        const stripped = stripDif(line);
        if (stripped.trim() === '') {
          continue; // line was only a DIF marker — skip entirely
        }
        line = stripped;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * @param {string} oldTex
 * @param {string} newTex
 * @param {{ workDir?: string }} [options]
 */
export default async function latexDiff(oldTex, newTex, options = {}) {
  const workDir = options.workDir || os.tmpdir();

  // Write temp files
  const oldPath = path.join(workDir, '__diff_old__.tex');
  const newPath = path.join(workDir, '__diff_new__.tex');

  try {
    fs.writeFileSync(oldPath, oldTex);
    fs.writeFileSync(newPath, newTex);

    const env = { ...process.env, PATH: TEX_PATHS + ':' + (process.env.PATH || '') };

    const { stdout, stderr } = await execFileAsync(
      'latexdiff',
      ['--type=UNDERLINE', '--encoding=utf8', oldPath, newPath],
      {
        env,
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024, // 50MB for large documents
        cwd: workDir,
      },
    );

    if (!stdout || !stdout.trim()) {
      throw new Error('latexdiff produced no output' + (stderr ? ': ' + stderr : ''));
    }

    return postProcess(stdout);
  } finally {
    // Clean up temp files
    try {
      fs.unlinkSync(oldPath);
    } catch {}
    try {
      fs.unlinkSync(newPath);
    } catch {}
  }
}
