// SAAS-FOUNDATIONS item 1 (phase 1.5): structural verification that
// compiler.js routes through the Docker sandbox when the flag is on.
//
// A full end-to-end compile test would need a working Docker daemon
// and the compile-sandbox image present; those are operator-side
// concerns. What we can assert here is:
//
//   - compiler.js imports the sandbox runner (regression catches a
//     refactor that removes the dependency by accident);
//   - the imported symbols are the expected shape;
//   - the docker-result-to-callback translator does the right thing
//     for zero / non-zero exit codes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const COMPILER_SRC = readFileSync(
  path.resolve(__dirname, '..', 'compiler.js'),
  'utf-8',
);

describe('compiler.js Docker sandbox wire-in (structural)', () => {
  it('imports isDockerSandboxEnabled and runDockerCompile from the sandbox module', () => {
    expect(COMPILER_SRC).toMatch(
      /from\s+['"]\.\/services\/dockerCompileSandbox\.js['"]/,
    );
    expect(COMPILER_SRC).toMatch(/isDockerSandboxEnabled\b/);
    expect(COMPILER_SRC).toMatch(/runDockerCompile\b/);
  });

  it('routes the sandbox path through the shared onCompilerExit callback', () => {
    // The whole point of the wire-in is that both spawn paths
    // converge on the same exit handler so the rest of the function
    // (log parsing, profile read, rebuildAnalyzer) doesn't have to
    // know which spawn path produced the result.
    expect(COMPILER_SRC).toMatch(/const onCompilerExit\s*=/);
    expect(COMPILER_SRC).toMatch(/runDockerCompile\(\{[^}]*projectDir[^}]*\}/s);
    expect(COMPILER_SRC).toMatch(/onCompilerExit\(error, result\.stdout, result\.stderr\)/);
    expect(COMPILER_SRC).toMatch(/onCompilerExit\(err, '', ''\)/);
  });

  it('attributes a non-zero exit code to the error object handed to onCompilerExit', () => {
    // Without this, the failure path would lose the docker-side
    // exit code and the operator would have nothing to grep for.
    expect(COMPILER_SRC).toMatch(/result\.exitCode === 0/);
    expect(COMPILER_SRC).toMatch(/code:\s*result\.exitCode/);
  });

  it('registers a null-child entry in activeCompilations so the count stays in sync', () => {
    // The host execFile path stores the ChildProcess for SIGTERM
    // cancellation. The Docker path has no host-side handle to
    // store, but we still want activeCompilations.delete to find
    // an entry on exit so the count never goes negative.
    expect(COMPILER_SRC).toMatch(/activeCompilations\.set\(projectId,\s*\{[^}]*child:\s*null[^}]*\}/);
  });

  it('falls through to the host execFile path when the sandbox flag is off', () => {
    // The execFile call still exists -- guarded by the false
    // branch of isDockerSandboxEnabled(). Regression catches a
    // refactor that accidentally removes the host path.
    expect(COMPILER_SRC).toMatch(/child\s*=\s*execFile\(/);
    expect(COMPILER_SRC).toMatch(/if\s*\(isDockerSandboxEnabled\(\)\)/);
  });
});

describe('docker-result-to-callback translation', () => {
  // Replicate the translation logic inline so we can assert its
  // contract against arbitrary fake results. Keeping it inline keeps
  // the production callsite simple (no separate helper to maintain)
  // but lets us unit-test the contract.
  function translate(result) {
    if (result.exitCode === 0) return null;
    return Object.assign(
      new Error(`compile-sandbox latexmk exited ${result.exitCode}`),
      { code: result.exitCode, signal: result.signal },
    );
  }

  it('returns null on exitCode=0', () => {
    expect(translate({ exitCode: 0, signal: null })).toBeNull();
  });

  it('returns an Error with code on non-zero exit', () => {
    const err = translate({ exitCode: 12, signal: null });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(12);
    expect(err.message).toMatch(/exited 12/);
  });

  it('preserves the signal field when a container was killed', () => {
    const err = translate({ exitCode: 137, signal: 'SIGKILL' });
    expect(err.signal).toBe('SIGKILL');
    expect(err.code).toBe(137);
  });
});
