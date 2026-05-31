#!/usr/bin/env node
/* global process */
// Per-tool stopwatch invoked by latexmk via $pdflatex / $bibtex / $biber /
// $makeindex / $xelatex / $lualatex overrides. Records one JSON line per
// invocation to the profile file passed via --profile=<path>, then forwards
// stdout/stderr and the child's exit code unchanged.
//
// Usage:
//   compileProfileWrapper.mjs --tool=<name> --profile=<path> -- <cmd> [args…]
//
// Designed to be robust: profile-writing failures never affect the compile
// result. If the wrapper itself can't parse its arguments it exits 127 so
// the compile fails loudly rather than silently mis-timing.

import { spawnSync } from 'child_process';
import fs from 'fs';

const args = process.argv.slice(2);
const sepIdx = args.indexOf('--');
if (sepIdx === -1) {
  process.stderr.write('compileProfileWrapper: missing -- separator\n');
  process.exit(127);
}
const flags = args.slice(0, sepIdx);
const cmdArgs = args.slice(sepIdx + 1);
if (cmdArgs.length === 0) {
  process.stderr.write('compileProfileWrapper: no command after --\n');
  process.exit(127);
}

let tool = '';
let profile = '';
for (const f of flags) {
  if (f.startsWith('--tool=')) tool = f.slice('--tool='.length);
  else if (f.startsWith('--profile=')) profile = f.slice('--profile='.length);
}
if (!tool || !profile) {
  process.stderr.write('compileProfileWrapper: --tool and --profile are required\n');
  process.exit(127);
}

const startMs = Date.now();
const result = spawnSync(cmdArgs[0], cmdArgs.slice(1), { stdio: 'inherit' });
const endMs = Date.now();
const exitCode = result.status ?? (result.signal ? 128 : 1);

const record = {
  tool,
  startMs,
  endMs,
  durationMs: endMs - startMs,
  exitCode,
  ...(result.signal ? { signal: result.signal } : {}),
};
try {
  fs.appendFileSync(profile, JSON.stringify(record) + '\n');
} catch {
  // Best-effort: never break the build over profiling.
}

process.exit(exitCode);
