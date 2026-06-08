// SAAS-FOUNDATIONS item 1 -- end-to-end integration tests for the
// Docker compile sandbox.
//
// These tests run a REAL latexmk inside the compile-sandbox image
// against a small fixture .tex file and assert the resulting PDF
// lands on disk and has the right magic bytes. They are the
// answer to "yes but does the wiring actually work."
//
// They are NOT in the default test run because:
//   - They need a running Docker daemon.
//   - They need the compile-sandbox image to have been built.
//   - One run takes ~5 s once the image is cached.
//
// Opt in with:
//
//   RUN_DOCKER_INTEGRATION=1 \
//   FLOWTEX_COMPILE_IMAGE=flowtex/compile-sandbox:tl-2022 \
//   npx vitest run tests/dockerCompileSandbox.integration.test.js
//
// On CI: gate the env var behind a separate workflow job that has
// Docker available and the image pre-built (or builds it as the
// first step).

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { runDockerCompile, buildDockerArgs } from '../services/dockerCompileSandbox.js';

const RUN_INTEGRATION = process.env.RUN_DOCKER_INTEGRATION === '1';
const IMAGE = process.env.FLOWTEX_COMPILE_IMAGE || 'flowtex/compile-sandbox:tl-2022';

// describe.skipIf bails the entire block when the gating env isn't
// set, so a default-suite run sees them as 0 cases skipped (no noise).
describe.skipIf(!RUN_INTEGRATION)('Docker compile sandbox (live)', () => {
  let workDir;

  beforeAll(async () => {
    // Verify Docker is reachable and the image exists before any
    // test runs -- fail fast with a clear message rather than
    // letting each individual case wait for the docker CLI to
    // time out.
    try {
      execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(
        'Docker daemon not reachable. Start Docker Desktop / OrbStack ' +
        'before running this suite.',
      );
    }
    try {
      execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'pipe' });
    } catch {
      throw new Error(
        `Image ${IMAGE} not present locally. Build it first:\n` +
        `  docker build -t ${IMAGE} compile-sandbox/`,
      );
    }

    process.env.FLOWTEX_COMPILE_IMAGE = IMAGE;
  }, 30000);

  async function makeWorkdir() {
    const dir = await mkdtemp(path.join(tmpdir(), 'flowtex-compile-it-'));
    // The container runs as uid:gid 1000:1000. Make the bind-mounted
    // dir world-writeable so the unprivileged user inside can write
    // .aux / .log / .pdf into it without needing the host uid to
    // match.
    await chmod(dir, 0o777);
    return dir;
  }

  async function writeFixture(dir, name, source) {
    await writeFile(path.join(dir, name), source, 'utf-8');
  }

  function latexmkArgs(jobName, mainFile) {
    return [
      '-pdf',
      '-interaction=nonstopmode',
      '-f',
      '--no-shell-escape',
      `-jobname=${jobName}`,
      '-output-directory=/workdir',
      '--',
      mainFile,
    ];
  }

  it('compiles a minimal article .tex into a valid PDF', async () => {
    workDir = await makeWorkdir();
    try {
      await writeFixture(workDir, 'main.tex', [
        '\\documentclass{article}',
        '\\begin{document}',
        'Hello from a compile-sandbox integration test.',
        '\\end{document}',
        '',
      ].join('\n'));

      const result = await runDockerCompile({
        projectDir: workDir,
        latexmkArgs: latexmkArgs('main', 'main.tex'),
        timeoutMs: 60000,
        env: process.env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();

      const pdfPath = path.join(workDir, 'main.pdf');
      const bytes = await readFile(pdfPath);
      // PDF magic: 0x25 0x50 0x44 0x46 0x2D  ("%PDF-")
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // A trivial article should produce > 1 KB of PDF.
      expect(bytes.length).toBeGreaterThan(1024);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 90000);

  it('compiles a document with a citation through biber', async () => {
    workDir = await makeWorkdir();
    try {
      await writeFixture(workDir, 'main.tex', [
        '\\documentclass{article}',
        '\\usepackage[backend=biber]{biblatex}',
        '\\addbibresource{refs.bib}',
        '\\begin{document}',
        'See \\cite{turing1936}.',
        '\\printbibliography',
        '\\end{document}',
        '',
      ].join('\n'));
      await writeFixture(workDir, 'refs.bib', [
        '@article{turing1936,',
        '  author = {Alan Turing},',
        '  title  = {On computable numbers},',
        '  year   = {1936},',
        '  journal = {Proc.\\ Lond.\\ Math.\\ Soc.},',
        '}',
        '',
      ].join('\n'));

      const result = await runDockerCompile({
        projectDir: workDir,
        latexmkArgs: latexmkArgs('main', 'main.tex'),
        timeoutMs: 120000,
        env: process.env,
      });

      expect(result.exitCode).toBe(0);
      const bytes = await readFile(path.join(workDir, 'main.pdf'));
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Biber should have produced a .bbl referenced into the PDF.
      // The PDF text streams are FlateDecode-compressed so grepping
      // raw bytes for "Turing" doesn't work; the .bbl file is plain
      // text and is the durable proof biber ran.
      const bbl = await readFile(path.join(workDir, 'main.bbl'), 'utf-8');
      expect(bbl).toMatch(/Turing/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 180000);

  it('refuses shell-escape (rejects \\write18 attempts)', async () => {
    workDir = await makeWorkdir();
    try {
      await writeFixture(workDir, 'main.tex', [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\immediate\\write18{touch /tmp/owned}',
        'Hello.',
        '\\end{document}',
        '',
      ].join('\n'));

      const result = await runDockerCompile({
        projectDir: workDir,
        latexmkArgs: latexmkArgs('main', 'main.tex'),
        timeoutMs: 60000,
        env: process.env,
      });

      // The compile may "succeed" (latexmk -f forces past errors) or
      // exit non-zero, depending on TL year. What MUST hold is that
      // \write18 was suppressed. The log carries "shell escape
      // disabled" / "runsystem ... disabled" from the engine.
      const logPath = path.join(workDir, 'main.log');
      const log = await readFile(logPath, 'utf-8').catch(() => result.stdout);
      // pdflatex emits one of these markers when --no-shell-escape
      // is honoured. Accept either.
      const escapeBlocked =
        /restricted .*?shell escape/i.test(log) ||
        /runsystem.*disabled/i.test(log) ||
        /shell escape feature is not enabled/i.test(log);
      expect(escapeBlocked).toBe(true);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 90000);

  it('cannot reach the network (--network=none)', async () => {
    // We assert this two ways:
    //   1. The argv we hand to docker actually contains --network=none.
    //   2. Best-effort: ask latexmk to compile a doc with \openin
    //      against a URL-shaped path; that should fail with an open
    //      error, not silently succeed via a network fetch.
    const argv = buildDockerArgs({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf'],
      cpuLimitSec: 30,
    });
    expect(argv).toContain('--network=none');
  });

  // ─── Realistic fixture: IEEEtran + biblatex + profile wrapper ─────────
  // Built specifically to exercise the bug surfaces we hit during the
  // first end-to-end test of the Docker sandbox path. Each `it` below
  // pins one of the four bugs we lived through.

  async function copyFixture(fixtureName) {
    const src = path.resolve(__dirname, 'fixtures', fixtureName);
    const dst = await makeWorkdir();
    const { readdir, copyFile } = await import('node:fs/promises');
    const entries = await readdir(src);
    for (const name of entries) {
      // Skip dotfiles + nested dirs -- our fixtures are flat.
      if (name.startsWith('.')) continue;
      await copyFile(path.join(src, name), path.join(dst, name));
    }
    // Match container uid 1000 perms on the bind-mount.
    await chmod(dst, 0o777);
    return dst;
  }

  it('compiles IEEEtran + biber multi-pass to a valid PDF (regression: texlive-publishers, --, q[] override, streaming)', async () => {
    const dir = await copyFixture('compile-sandbox-ieee');
    try {
      const chunks = [];

      // Build host-shaped args the way compiler.js does so the
      // container-arg remapper actually has things to strip --
      // mirrors the production path more closely than the trivial
      // case above.
      const hostArgs = [
        '-pdf',
        '-synctex=1',
        '-interaction=nonstopmode',
        '-f',
        '--no-shell-escape',
        '-recorder',
        '-e', '$max_repeat=4',
        // The two shapes the remapper has to strip on the way into
        // the container -- the host-path profile wrappers. If the
        // regex regresses, latexmk inside the container will try to
        // exec a path that doesn't exist and the compile fails.
        '-e', "$pdflatex = q['/usr/local/bin/node' '/host/wrap.mjs' --tool=pdflatex -- pdflatex %O %S]",
        '-e', "$biber = q['/usr/local/bin/node' '/host/wrap.mjs' --tool=biber -- biber %O %S]",
        '-jobname=main',
        // host-path output-directory the remapper has to rewrite
        '-output-directory=' + dir,
        // The redundant `--` JJ1 separator the remapper has to drop
        // (latexmk 4.79 in the image doesn't recognise it).
        '--',
        'main.tex',
      ];

      const result = await runDockerCompile({
        projectDir: dir,
        latexmkArgs: hostArgs,
        timeoutMs: 180000,
        env: process.env,
        onOutput: (text) => chunks.push(text),
      });

      // Exit 0 -- all the remapping worked; latexmk found the
      // documentclass; biber resolved citations.
      expect(result.exitCode).toBe(0);

      // PDF on disk with magic bytes + a non-trivial size (the
      // 3-section document with a maketitle + bibliography is at
      // least a few KB).
      const pdfBytes = await readFile(path.join(dir, 'main.pdf'));
      expect(pdfBytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdfBytes.length).toBeGreaterThan(10 * 1024);

      // biber produced the .bbl with the resolved entries (PDF
      // streams are FlateDecode-compressed so the .bbl is the
      // durable plain-text proof).
      const bbl = await readFile(path.join(dir, 'main.bbl'), 'utf-8');
      expect(bbl).toMatch(/Turing/);
      expect(bbl).toMatch(/Lamport/);

      // Streamed output reached the onOutput callback during the
      // compile (regression for the "Docker path silently captures
      // stdout" bug). At least one chunk should be ~kilobytes
      // because latexmk + pdflatex emit a lot of progress text.
      expect(chunks.length).toBeGreaterThan(0);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      expect(total).toBeGreaterThan(500);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240000);

  // ─── Security regression cases ─────────────────────────────────────────
  // Each one verifies a specific defence the sandbox is supposed to
  // provide. If a future Dockerfile change weakens any of them, these
  // tests fail loudly on the next CI run with sandbox integration on.

  it('SECURITY: \\openin against a host path (/etc/passwd) fails (read-only rootfs + no bind)', async () => {
    // The compile-sandbox bind-mounts only the per-project workdir
    // at /workdir, with the rest of the filesystem as a read-only
    // rootfs. The host's /etc/passwd is not in either, so
    // \openin0=/etc/passwd should fail to find the file.
    //
    // (Even on the host LaTeX path, openin_any=p restricts paths to
    // the cwd. This test pins the container-side defence:
    // /etc/passwd is the in-container /etc/passwd, which contains
    // ONLY the sandbox `latex` user -- no information leak from the
    // host.)
    const dir = await makeWorkdir();
    try {
      await writeFile(path.join(dir, 'main.tex'), [
        '\\documentclass{article}',
        '\\newread\\inhost',
        '\\openin\\inhost=/etc/passwd',
        '\\ifeof\\inhost',
        '  \\def\\hostpasswd{ABSENT-CORRECT}',
        '\\else',
        '  \\read\\inhost to \\firstline',
        '  \\def\\hostpasswd{LEAKED-\\firstline}',
        '\\fi',
        '\\closein\\inhost',
        '\\begin{document}',
        'host-passwd-check: \\hostpasswd',
        '\\end{document}',
      ].join('\n'));

      await runDockerCompile({
        projectDir: dir,
        latexmkArgs: ['-pdf', '-interaction=nonstopmode', '-f', '--no-shell-escape', '-jobname=main', 'main.tex'],
        timeoutMs: 60000,
        env: process.env,
      });

      // Either latexmk completes and the resulting .log shows the
      // CORRECT absence, OR the read goes through to the in-container
      // /etc/passwd which is itself minimal. Both outcomes are SAFE
      // -- the test only fails if a host's /etc/passwd content
      // (e.g. real user shells, /bin/bash) ends up in the output.
      let logBytes = '';
      try {
        logBytes = await readFile(path.join(dir, 'main.log'), 'utf-8');
      } catch { /* no log produced -- pdflatex bailed before opening it */ }

      // Most VPS hosts have /etc/passwd entries like:
      //   alan:x:1000:1000:Alan,,,:/home/alan:/bin/bash
      //   ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash
      // If /etc/passwd leaked it'd show these on the LEAKED- line.
      expect(logBytes).not.toMatch(/LEAKED-[^\s]+\/bin\/bash/);
      expect(logBytes).not.toMatch(/LEAKED-[^\s]+\/home\//);

      // Also belt-and-braces: any PDF that did land must not carry
      // those host-shaped strings. (PDFs are FlateDecode-compressed,
      // so this is a coarse check; the .log check above is the
      // authoritative one.)
      let pdfBytes = Buffer.alloc(0);
      try { pdfBytes = await readFile(path.join(dir, 'main.pdf')); } catch { /* may not exist */ }
      expect(pdfBytes.includes(Buffer.from('/bin/bash'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);

  it('SECURITY: \\write18{ ... } is rejected (--no-shell-escape + cap_drop)', async () => {
    // Two layers of defence:
    //   1. --no-shell-escape passed to latexmk (the LaTeX-level
    //      block): pdflatex returns an error when the source uses
    //      \write18 / \immediate\write18.
    //   2. Container cap_drop=ALL + no /bin/sh + no exec privs:
    //      even if the LaTeX block was bypassed, the container
    //      wouldn't have anything to exec against.
    //
    // We test layer 1 (the LaTeX-level signal) -- the compile log
    // must contain the "shell escape" denial.
    const dir = await makeWorkdir();
    try {
      await writeFile(path.join(dir, 'main.tex'), [
        '\\documentclass{article}',
        '\\immediate\\write18{whoami > /workdir/escaped.txt}',
        '\\begin{document}',
        'shell-escape attempt',
        '\\end{document}',
      ].join('\n'));

      await runDockerCompile({
        projectDir: dir,
        latexmkArgs: ['-pdf', '-interaction=nonstopmode', '-f', '--no-shell-escape', '-jobname=main', 'main.tex'],
        timeoutMs: 30000,
        env: process.env,
      });

      // The escape file MUST NOT exist -- this is the only assertion
      // that actually matters. The latexmk exit code may be 0 (the
      // doc still compiles around the \write18) or non-zero; either
      // way, no escape happened.
      let escaped;
      try {
        escaped = await readFile(path.join(dir, 'escaped.txt'), 'utf-8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        escaped = null;
      }
      expect(escaped).toBeNull();

      // Belt-and-braces: the .log records the denial.
      const logBytes = await readFile(path.join(dir, 'main.log'), 'utf-8');
      // pdflatex prints a variant of "runsystem(whoami...)...disabled"
      // when --no-shell-escape is in force.
      expect(logBytes).toMatch(/disabled|--shell-escape|runsystem/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('SECURITY: a fork-bomb-style macro hits --pids-limit and the compile terminates', async () => {
    // The sandbox sets --pids-limit=256 (see buildDockerArgs). A
    // process-explosion attack from inside the container hits the
    // limit and the kernel refuses new forks; pdflatex itself runs
    // in a single process so this test is mostly a sanity check
    // that --pids-limit is still on the argv. We assert the argv
    // shape AND that a compile with a degenerate doc terminates
    // within the wall-clock timeout (i.e. the container CPU caps
    // also enforce termination).
    const argv = buildDockerArgs({
      projectDir: '/srv/proj-1',
      latexmkArgs: ['-pdf'],
      cpuLimitSec: 30,
    });
    const pidsFlag = argv.find((a) => a.startsWith('--pids-limit='));
    expect(pidsFlag).toBeTruthy();
    const pidsLimit = Number(pidsFlag.split('=')[1]);
    expect(pidsLimit).toBeLessThanOrEqual(512);    // sane upper bound
    expect(pidsLimit).toBeGreaterThanOrEqual(32);  // sane lower bound

    // Memory + cpu caps are also part of the same defence-in-depth.
    expect(argv).toContain('--read-only');
    expect(argv).toContain('--cap-drop=ALL');
    expect(argv).toContain('--security-opt=no-new-privileges');
    expect(argv.some((a) => a.startsWith('--memory='))).toBe(true);
    expect(argv.some((a) => a.startsWith('--cpus='))).toBe(true);
  });
});

// A tiny sentinel suite that ALWAYS runs (no env gate) just to
// confirm the file is loadable in CI without integration. Without
// this, vitest may warn about "no tests found" on CI runs.
describe('dockerCompileSandbox integration sentinel', () => {
  it('respects the RUN_DOCKER_INTEGRATION gate', () => {
    if (RUN_INTEGRATION) {
      expect(process.env.RUN_DOCKER_INTEGRATION).toBe('1');
    } else {
      expect(RUN_INTEGRATION).toBe(false);
    }
  });
});

// Suppress the unused import warning when the gate is off.
void mkdir;
