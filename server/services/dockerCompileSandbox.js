// @ts-check
// SAAS-FOUNDATIONS item 1 -- Docker-based compile sandbox.
//
// Spawns latexmk inside a sibling container per compile. The image
// is a tiny TeX Live layer (compile-sandbox/Dockerfile) running as a
// non-root user with no network, a read-only root, a writeable bind
// mount on the project's working directory, and memory / CPU /
// process caps applied via `docker run` flags. This is the model
// Overleaf uses in services/clsi -- see CLSI's SANDBOXED_COMPILES
// flag -- and the only safe model for untrusted tenants.
//
// Selection is per-process via FLOWTEX_COMPILE_SANDBOX:
//
//   in-process (default) -- existing prlimit-flagged latexmk; the
//     right answer for self-hosted academic groups where all users
//     are trusted.
//
//   docker -- this runner; the right answer for SaaS / public
//     deploys. Requires the Docker daemon to be reachable from the
//     server process and the FLOWTEX_COMPILE_IMAGE env var to point
//     at a built sandbox image.
//
// Build the image once with:
//
//   docker build -t flowtex/compile-sandbox:tl-2025 compile-sandbox/
//
// Caps applied to every run:
//   --network=none           no outbound calls; sandboxes any \input{|...}
//                            escape route TeX has historically had
//   --read-only              root fs is read-only; only the bind mount
//                            and /tmp are writeable
//   --tmpfs /tmp:size=512M   bounded ephemeral tmp
//   --memory                 RSS cap (default 2 GiB)
//   --memory-swap            equal to --memory so swap can't be used
//   --pids-limit             prevents fork bombs in TeX macro hell
//   --cpus                   CPU cap matched to the JS timeout window
//   --user 1000:1000         non-root inside the container
//   --cap-drop ALL           drop every Linux capability
//   --security-opt no-new-privileges
//   --rm                     never leave dead containers behind
//
// The bind mount is the project's working directory under
// PROJECTS_DIR. We rely on the same path validation the in-process
// compiler does (isValidFilePath rejects ../ and leading -, jobName
// is alphanumeric). The image's runner script (compile-sandbox/
// run-latexmk.sh) is the entrypoint, so the only attack surface is
// the argv list we pass.

import { spawn } from 'node:child_process';
import path from 'node:path';
import logger from '../logger.js';

const PROJECTS_DIR_RE = /^[/\w.-]+$/;

// Default container UID/GID: match the host process's UID/GID so
// the container can write into the bind-mounted project dir without
// chmod-777 gymnastics or chown-ing project dirs to a random UID.
//
// macOS Docker Desktop maps UIDs transparently and "any UID inside
// works" -- which masked the bug for the original integration test
// run on Mac. On Linux, the container UID must match the host file
// owner (or have group access), or write attempts ENOSPC/EACCES.
//
// The compile-sandbox image was built with a `latex` user at UID
// 1000 -- but TeX itself doesn't care if the container UID has no
// /etc/passwd entry, so running as the host's UID works fine.
// Operators with an unusual setup can override via the env var.
function defaultContainerUser() {
  // Both getuid/getgid are POSIX-only; Windows tests can override
  // via FLOWTEX_COMPILE_USER. On any POSIX host this is the right
  // default.
  if (typeof process.getuid !== 'function') return '1000:1000';
  const uid = process.getuid();
  // SECURITY: refuse to default to UID 0 inside the container.
  // The systemd unit shipped by provision-vps.sh runs FlowTex as
  // a non-root flowtex user, so process.getuid()===0 means the
  // operator is running the server as root (or the unit is
  // misconfigured). Even with cap_drop=ALL + no-new-privileges,
  // root-inside-container is enough of a defence-in-depth smell
  // that we'd rather fail loud than silently weaken the sandbox.
  // Operators with a real reason can override via FLOWTEX_COMPILE_USER.
  if (uid === 0) {
    throw new Error(
      'dockerCompileSandbox: refusing to default container UID to 0 (root) -- ' +
      'run FlowTex as a non-root user, or set FLOWTEX_COMPILE_USER=<uid>:<gid> explicitly.',
    );
  }
  // process.getgid is undefined on Windows but defined everywhere we
  // would actually run the Docker sandbox (Linux + macOS). The Error
  // above already handles the missing-getuid case implicitly.
  const getgid = process.getgid;
  if (!getgid) throw new Error('dockerCompileSandbox: process.getgid unavailable on this platform');
  return `${uid}:${getgid()}`;
}

const SANDBOX_DEFAULTS = {
  memory: process.env.FLOWTEX_COMPILE_MEMORY || '2g',
  pidsLimit: parseInt(process.env.FLOWTEX_COMPILE_PIDS_LIMIT || '256', 10),
  cpus: process.env.FLOWTEX_COMPILE_CPUS || '2.0',
  tmpfsSize: process.env.FLOWTEX_COMPILE_TMPFS_SIZE || '512m',
  user: process.env.FLOWTEX_COMPILE_USER || defaultContainerUser(),
  dockerBin: process.env.FLOWTEX_DOCKER_BIN || 'docker',
};

/**
 * @returns {string} the image to use for compile-sandbox runs.
 * Throws if the env var is unset -- we never silently fall back to
 * a "latest" tag because that's the kind of supply-chain footgun
 * SaaS deploys must not have.
 */
function getImage() {
  const image = process.env.FLOWTEX_COMPILE_IMAGE;
  if (!image) {
    throw new Error(
      'FLOWTEX_COMPILE_SANDBOX=docker requires FLOWTEX_COMPILE_IMAGE ' +
      '(e.g. flowtex/compile-sandbox:tl-2025).',
    );
  }
  return image;
}

/**
 * Remap a host-shaped latexmk argv into a container-shaped one.
 *
 *   - `-output-directory=<host path>` → `-output-directory=/workdir`
 *     because the host projectDir is bind-mounted at /workdir; the
 *     host path doesn't exist inside the container.
 *   - The `--` option terminator (JJ1's belt-and-braces from audit
 *     round 21) is stripped because latexmk 4.79 (the version
 *     Bookworm ships in our sandbox image) doesn't recognise it.
 *     Argument injection from filenames starting with `-` is still
 *     prevented by `isValidFilePath` upstream, which is the
 *     authoritative guard.
 *   - The host-side profile-wrapper overrides (`-e $pdflatex=q[ /host/...]`)
 *     reference scripts that live in the host filesystem. They're
 *     stripped here -- profile capture is a performance / debug
 *     feature, not a correctness one, and it gracefully degrades to
 *     "no profile produced" when readCompileProfile finds no file.
 *
 * Pure function; unit-tested.
 */
/** @param {string[]} latexmkArgs */
export function remapLatexmkArgsForContainer(latexmkArgs) {
  if (!Array.isArray(latexmkArgs)) return latexmkArgs;
  const out = [];
  for (let i = 0; i < latexmkArgs.length; i++) {
    const a = latexmkArgs[i];
    if (typeof a !== 'string') { out.push(a); continue; }
    if (a === '--') continue;
    if (a.startsWith('-output-directory=')) {
      out.push('-output-directory=/workdir');
      continue;
    }
    if (a === '-e' && i + 1 < latexmkArgs.length) {
      const next = latexmkArgs[i + 1];
      // Profile overrides look like `$pdflatex = q[ ... ]` where the
      // q[]-delimited string includes the host-side Node and the
      // wrapper script path. They reference the host filesystem and
      // can't run inside the container, so we drop both `-e` and its
      // value. A user-supplied `-e` whose value is NOT a q[]-wrapped
      // override (e.g. `-e $max_repeat=4`) is preserved because the
      // pattern requires `q[` after the `=`.
      if (typeof next === 'string' && /^\$\w+\s*=\s*q\[/.test(next)) {
        i += 1;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/**
 * Build the `docker run` argv that wraps a latexmk invocation. Pure
 * function; the actual spawn happens in runDockerCompile below. Split
 * so tests can assert the wrapping without invoking Docker.
 *
 * @typedef {{
 *   memory: string,
 *   pidsLimit: number,
 *   cpus: string,
 *   tmpfsSize: string,
 *   user: string,
 * }} SandboxOpts
 *
 * @param {{ projectDir: string, latexmkArgs: string[], cpuLimitSec: number }} args
 * @param {SandboxOpts} [opts]
 */
export function buildDockerArgs({ projectDir, latexmkArgs, cpuLimitSec }, opts = SANDBOX_DEFAULTS) {
  if (typeof projectDir !== 'string' || !projectDir.startsWith('/') || !PROJECTS_DIR_RE.test(projectDir)) {
    throw new Error('buildDockerArgs: projectDir must be an absolute path under PROJECTS_DIR');
  }
  if (!Array.isArray(latexmkArgs) || latexmkArgs.some((a) => typeof a !== 'string')) {
    throw new Error('buildDockerArgs: latexmkArgs must be an array of strings');
  }
  const image = getImage();
  const containerArgs = remapLatexmkArgsForContainer(latexmkArgs);
  return [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    `--tmpfs=/tmp:size=${opts.tmpfsSize},mode=1777`,
    `--memory=${opts.memory}`,
    `--memory-swap=${opts.memory}`,
    `--pids-limit=${String(opts.pidsLimit)}`,
    `--cpus=${opts.cpus}`,
    `--user=${opts.user}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--volume=${projectDir}:/workdir:rw`,
    '--workdir=/workdir',
    // Stop signal + grace -- latexmk is the entrypoint via the
    // run-latexmk.sh script; SIGTERM gives it a chance to clean up
    // .aux files before SIGKILL fires.
    '--stop-signal=SIGTERM',
    `--stop-timeout=${Math.max(5, Math.min(60, Math.ceil(cpuLimitSec / 4)))}`,
    image,
    ...containerArgs,
  ];
}

/**
 * Run a single compile inside a fresh sandbox container. Resolves
 * with `{ exitCode, stdout, stderr, durationMs }`. Never throws on
 * compile failure -- only on Docker-itself failures (binary missing,
 * daemon unreachable).
 *
 * Optional `onOutput(chunk)` fires for each stdout/stderr chunk as
 * it arrives, mirroring what the host execFile path does via
 * `child.stdout.on('data')`. Without this the compile-stream SSE
 * sees no output between "Compiling..." and the final `done` event,
 * which looks like the compile is hung even when it's running.
 */
/**
 * @param {{
 *   projectDir: string,
 *   latexmkArgs: string[],
 *   timeoutMs: number,
 *   env?: Record<string, string>,
 *   onOutput?: (chunk: string) => void
 * }} args
 */
export async function runDockerCompile({ projectDir, latexmkArgs, timeoutMs, env, onOutput }) {
  const cpuLimitSec = Math.ceil(timeoutMs / 1000) + 10;
  const args = buildDockerArgs({ projectDir, latexmkArgs, cpuLimitSec });
  const { dockerBin } = SANDBOX_DEFAULTS;
  const start = Date.now();

  logger.info(
    { projectDir, image: process.env.FLOWTEX_COMPILE_IMAGE, timeoutMs },
    'compile-sandbox: spawning docker run',
  );

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(dockerBin, args, {
      env,
      // The Docker CLI must NOT inherit a tty -- we want clean
      // pipes for stdout/stderr capture. detached=false so a host-
      // level kill propagates.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // Docker also has its own --stop-timeout but if the CLI itself
      // wedges (rare; daemon unreachable), this is the JS-side
      // backstop.
    }, timeoutMs + 5000);

    child.stdout.on('data', (chunk) => {
      // Bound stdout/stderr capture at 10 MiB each so a runaway
      // /tmp dump can't OOM the server process.
      const text = chunk.toString('utf-8');
      if (stdout.length < 10 * 1024 * 1024) {
        stdout += text;
      }
      if (onOutput) {
        try { onOutput(text); } catch { /* never let a streaming-callback bug kill the compile */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      if (stderr.length < 10 * 1024 * 1024) {
        stderr += text;
      }
      if (onOutput) {
        try { onOutput(text); } catch { /* swallow */ }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}

/** True iff Docker is the configured sandbox for this process. */
export function isDockerSandboxEnabled() {
  return (process.env.FLOWTEX_COMPILE_SANDBOX || 'in-process').toLowerCase() === 'docker';
}
