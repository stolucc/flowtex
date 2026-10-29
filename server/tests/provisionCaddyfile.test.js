// provision-vps.sh regenerates /etc/caddy/Caddyfile on every run. Other apps
// on the same host (PLS Studio) keep their site blocks in /etc/caddy/conf.d/,
// so the generated file must import that directory or a FlowTex re-provision
// silently takes those sites offline.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'provision-vps.sh');
const src = readFileSync(SCRIPT, 'utf8');

function caddyfileTemplate() {
  const start = src.indexOf('cat > /etc/caddy/Caddyfile <<CADDY\n');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start).split('\n').slice(1);
  return body.slice(0, body.indexOf('CADDY')).join('\n');
}

describe('provision-vps.sh Caddyfile', () => {
  it('imports /etc/caddy/conf.d/*.caddy at top level, after the FlowTex site', () => {
    const lines = caddyfileTemplate().split('\n').filter((l) => l.trim());
    expect(lines.at(-1)).toBe('import /etc/caddy/conf.d/*.caddy');
  });

  it('creates the conf.d directory before writing the Caddyfile', () => {
    const mkdir = src.indexOf('mkdir -p /etc/caddy/conf.d');
    expect(mkdir).toBeGreaterThan(-1);
    expect(mkdir).toBeLessThan(src.indexOf('cat > /etc/caddy/Caddyfile'));
  });

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });
});
