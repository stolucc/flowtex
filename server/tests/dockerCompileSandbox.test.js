import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock child_process.spawn for the run tests. The mock returns a
// minimal EventEmitter shape that the runner reads.
import { EventEmitter } from 'node:events';
let spawnImpl;
vi.mock('node:child_process', () => ({
  spawn: (...args) => spawnImpl(...args),
}));

import {
  buildDockerArgs,
  runDockerCompile,
  isDockerSandboxEnabled,
  remapLatexmkArgsForContainer,
} from '../services/dockerCompileSandbox.js';

const PRESERVE = [
  'FLOWTEX_COMPILE_SANDBOX',
  'FLOWTEX_COMPILE_IMAGE',
  'FLOWTEX_COMPILE_MEMORY',
  'FLOWTEX_COMPILE_PIDS_LIMIT',
  'FLOWTEX_COMPILE_CPUS',
];
const saved = {};
beforeEach(() => {
  for (const k of PRESERVE) saved[k] = process.env[k];
  process.env.FLOWTEX_COMPILE_IMAGE = 'flowtex/compile-sandbox:test';
});
afterEach(() => {
  for (const k of PRESERVE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  spawnImpl = undefined;
});

describe('buildDockerArgs', () => {
  it('wraps latexmk args in the locked-down docker run flags', () => {
    const argv = buildDockerArgs({
      projectDir: '/srv/flowtex/projects/proj-1',
      latexmkArgs: ['-pdf', '--no-shell-escape', '--', 'main.tex'],
      cpuLimitSec: 60,
    });
    expect(argv[0]).toBe('run');
    expect(argv).toContain('--network=none');
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--cap-drop=ALL');
    expect(argv).toContain('--security-opt=no-new-privileges');
    expect(argv).toContain('--user=1000:1000');
    expect(argv).toContain('--volume=/srv/flowtex/projects/proj-1:/workdir:rw');
    expect(argv).toContain('--workdir=/workdir');
    expect(argv).toContain('flowtex/compile-sandbox:test');
    // latexmk argv survives the wrap, but the `--` separator is
    // stripped by remapLatexmkArgsForContainer (Bookworm latexmk
    // 4.79 doesn't recognise it; isValidFilePath rejects
    // leading-dash filenames upstream as the authoritative guard).
    expect(argv.slice(-3)).toEqual(['-pdf', '--no-shell-escape', 'main.tex']);
  });

  it('threads memory / pids / cpu caps from env', () => {
    process.env.FLOWTEX_COMPILE_MEMORY = '4g';
    process.env.FLOWTEX_COMPILE_PIDS_LIMIT = '128';
    process.env.FLOWTEX_COMPILE_CPUS = '1.5';
    // Re-import to pick up the new env (the SANDBOX_DEFAULTS object
    // captures env at module-load time, so we use the opts override
    // path that the function exposes for tests).
    const argv = buildDockerArgs(
      { projectDir: '/srv/proj-1', latexmkArgs: ['-pdf'], cpuLimitSec: 30 },
      { memory: '4g', pidsLimit: 128, cpus: '1.5', tmpfsSize: '256m', user: '1000:1000' },
    );
    expect(argv).toContain('--memory=4g');
    expect(argv).toContain('--memory-swap=4g');
    expect(argv).toContain('--pids-limit=128');
    expect(argv).toContain('--cpus=1.5');
    expect(argv).toContain('--tmpfs=/tmp:size=256m,mode=1777');
  });

  it('throws when projectDir is not an absolute path', () => {
    expect(() => buildDockerArgs({
      projectDir: 'relative/path',
      latexmkArgs: ['-pdf'],
      cpuLimitSec: 30,
    })).toThrow(/absolute path/);
  });

  it('throws when projectDir contains shell metacharacters', () => {
    expect(() => buildDockerArgs({
      projectDir: '/srv/proj-1;rm -rf /',
      latexmkArgs: ['-pdf'],
      cpuLimitSec: 30,
    })).toThrow(/absolute path/);
  });

  it('throws when latexmkArgs contains a non-string', () => {
    expect(() => buildDockerArgs({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf', 42],
      cpuLimitSec: 30,
    })).toThrow(/array of strings/);
  });

  it('throws when FLOWTEX_COMPILE_IMAGE is unset', () => {
    delete process.env.FLOWTEX_COMPILE_IMAGE;
    expect(() => buildDockerArgs({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf'],
      cpuLimitSec: 30,
    })).toThrow(/FLOWTEX_COMPILE_IMAGE/);
  });
});

describe('runDockerCompile', () => {
  it('resolves with stdout/stderr/exitCode on a 0 exit', async () => {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = vi.fn();
    spawnImpl = vi.fn().mockReturnValue(fake);

    const p = runDockerCompile({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf', '--', 'main.tex'],
      timeoutMs: 30000,
      env: {},
    });

    fake.stdout.emit('data', Buffer.from('LaTeX is running\n'));
    fake.stderr.emit('data', Buffer.from(''));
    fake.emit('exit', 0, null);

    const result = await p;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/LaTeX is running/);
    expect(result.signal).toBeNull();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnImpl.mock.calls[0];
    expect(bin).toBe('docker');
    expect(args[0]).toBe('run');
  });

  it('streams stdout + stderr chunks to onOutput as they arrive', async () => {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = vi.fn();
    spawnImpl = vi.fn().mockReturnValue(fake);

    const chunks = [];
    const p = runDockerCompile({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf', 'main.tex'],
      timeoutMs: 30000,
      env: {},
      onOutput: (chunk) => chunks.push(chunk),
    });

    fake.stdout.emit('data', Buffer.from('first stdout\n'));
    fake.stderr.emit('data', Buffer.from('a warning\n'));
    fake.stdout.emit('data', Buffer.from('second stdout\n'));
    fake.emit('exit', 0, null);

    await p;
    expect(chunks).toEqual(['first stdout\n', 'a warning\n', 'second stdout\n']);
  });

  it('survives a throwing onOutput without crashing the compile', async () => {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = vi.fn();
    spawnImpl = vi.fn().mockReturnValue(fake);

    const p = runDockerCompile({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf', 'main.tex'],
      timeoutMs: 30000,
      env: {},
      onOutput: () => { throw new Error('callback bug'); },
    });

    fake.stdout.emit('data', Buffer.from('chunk\n'));
    fake.emit('exit', 0, null);
    const result = await p;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/chunk/);
  });

  it('rejects when the docker CLI itself fails to spawn', async () => {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = vi.fn();
    spawnImpl = vi.fn().mockReturnValue(fake);

    const p = runDockerCompile({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf'],
      timeoutMs: 30000,
      env: {},
    });
    fake.emit('error', new Error('docker: command not found'));
    await expect(p).rejects.toThrow(/docker: command not found/);
  });

  it('bounds stdout capture so a runaway process can\'t OOM the parent', async () => {
    const fake = new EventEmitter();
    fake.stdout = new EventEmitter();
    fake.stderr = new EventEmitter();
    fake.kill = vi.fn();
    spawnImpl = vi.fn().mockReturnValue(fake);

    const p = runDockerCompile({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf'],
      timeoutMs: 30000,
      env: {},
    });
    // Emit > 10 MiB across multiple chunks.
    const big = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a'
    for (let i = 0; i < 12; i++) fake.stdout.emit('data', big);
    fake.emit('exit', 0, null);
    const result = await p;
    expect(result.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 1024 * 1024);
  });
});

describe('remapLatexmkArgsForContainer', () => {
  it('strips the `--` separator (latexmk 4.79 in Bookworm rejects it)', () => {
    expect(remapLatexmkArgsForContainer(['-pdf', '--', 'main.tex']))
      .toEqual(['-pdf', 'main.tex']);
  });

  it('rewrites -output-directory=<host path> to /workdir', () => {
    expect(remapLatexmkArgsForContainer([
      '-pdf', '-output-directory=/srv/flowtex/projects/proj-1', 'main.tex',
    ])).toEqual([
      '-pdf', '-output-directory=/workdir', 'main.tex',
    ]);
  });

  it('strips host-side profile wrapper overrides (`-e $pdflatex=q[ ... ]`)', () => {
    // Real profileLatexmkOverrides output single-quotes the host
    // exec path inside q[...] -- e.g.
    //   $pdflatex = q[ '/path/to/node' '/path/to/wrap.mjs' --tool=... ]
    // The earlier regex required a literal `/` after `q[` which the
    // real output does NOT have because q[ is followed by '. Match
    // any q[ wrapper now.
    const argv = [
      '-pdf',
      '-e', "$pdflatex = q['/opt/node' '/opt/wrap.mjs' --tool=pdflatex -- pdflatex %O %S]",
      '-e', "$bibtex = q['/opt/node' '/opt/wrap.mjs' --tool=bibtex -- bibtex %O %S]",
      'main.tex',
    ];
    expect(remapLatexmkArgsForContainer(argv))
      .toEqual(['-pdf', 'main.tex']);
  });

  it('preserves a user -e that is not a host-path profile wrapper', () => {
    const argv = ['-pdf', '-e', '$max_repeat=4', 'main.tex'];
    expect(remapLatexmkArgsForContainer(argv))
      .toEqual(['-pdf', '-e', '$max_repeat=4', 'main.tex']);
  });

  it('non-array input is returned unchanged', () => {
    expect(remapLatexmkArgsForContainer(null)).toBeNull();
    expect(remapLatexmkArgsForContainer('hi')).toBe('hi');
  });
});

describe('isDockerSandboxEnabled', () => {
  it('is false by default', () => {
    delete process.env.FLOWTEX_COMPILE_SANDBOX;
    expect(isDockerSandboxEnabled()).toBe(false);
  });
  it('is true when FLOWTEX_COMPILE_SANDBOX=docker', () => {
    process.env.FLOWTEX_COMPILE_SANDBOX = 'docker';
    expect(isDockerSandboxEnabled()).toBe(true);
  });
  it('is case-insensitive on the env value', () => {
    process.env.FLOWTEX_COMPILE_SANDBOX = 'DOCKER';
    expect(isDockerSandboxEnabled()).toBe(true);
  });
});
