// provision-vps.sh preflight: reading DOMAIN / ADMIN_EMAIL / INSTANCE_COUNT
// back from an existing install. Runs the script's own preflight block under
// the same `set -euo pipefail` it uses in production.
//
// Regression: an install whose .env lacked FLOWTEX_INSTANCE_COUNT made the
// script exit silently right after "Reusing ADMIN_EMAIL" (grep found nothing
// -> pipefail -> set -e). And defaulting to 1 there would have deleted the
// extra flowtex-N instance units.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'provision-vps.sh');
const src = readFileSync(SCRIPT, 'utf8');

// From reading the existing .env up to the INSTANCE_COUNT validation.
const start = src.indexOf('__EXISTING_ENV="${APP_DIR}/.env"');
const end = src.indexOf('[ "$INSTANCE_COUNT" -ge 1 ]');
const PREFLIGHT = src.slice(start, end);

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'provision-'));
  mkdirSync(path.join(dir, 'units'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the preflight block; returns the resolved values. */
function preflight(envLines, units = [], extraEnv = {}) {
  writeFileSync(path.join(dir, '.env'), envLines.join('\n') + '\n');
  for (const u of units) writeFileSync(path.join(dir, 'units', u), '');
  const script = [
    'set -euo pipefail',
    'log() { :; }',
    'die() { echo "DIE: $*"; exit 1; }',
    PREFLIGHT,
    'echo "DOMAIN=$DOMAIN"',
    'echo "INSTANCE_COUNT=$INSTANCE_COUNT"',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH, APP_DIR: dir, SYSTEMD_UNIT_DIR: path.join(dir, 'units'), ...extraEnv },
    encoding: 'utf8',
  });
  return Object.fromEntries(out.trim().split('\n').map((l) => l.split('=')));
}

const BASE = ['APP_URL=https://flowtex.click', 'ADMIN_EMAIL=admin@example.org'];

describe('provision-vps.sh preflight', () => {
  it('does not exit silently when FLOWTEX_INSTANCE_COUNT is missing from .env', () => {
    const r = preflight(BASE);
    expect(r.DOMAIN).toBe('flowtex.click');
    expect(r.INSTANCE_COUNT).toBe('1');
  });

  it('keeps an unpersisted multi-instance setup at its size (highest flowtex-N unit)', () => {
    const r = preflight(BASE, ['flowtex-2.service', 'flowtex-3.service', 'flowtex-4.service', 'flowtex-yjs-worker.service']);
    expect(r.INSTANCE_COUNT).toBe('4');
  });

  it('prefers the persisted count, and an explicit INSTANCE_COUNT over both', () => {
    expect(preflight([...BASE, 'FLOWTEX_INSTANCE_COUNT=3'], ['flowtex-2.service']).INSTANCE_COUNT).toBe('3');
    expect(preflight([...BASE, 'FLOWTEX_INSTANCE_COUNT=3'], [], { INSTANCE_COUNT: '2' }).INSTANCE_COUNT).toBe('2');
  });

  it('a .env without APP_URL fails with the DOMAIN message, not silently', () => {
    let out = '';
    try {
      preflight(['ADMIN_EMAIL=admin@example.org']);
    } catch (e) {
      out = String(e.stderr);
    }
    expect(out).toMatch(/Set DOMAIN=/);
  });
});
