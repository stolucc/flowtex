// Unit tests for the extracted buildLatexmkArgs pure function.
// Mutation testing surfaced that the latexmk argv in compiler.js
// was buried inside _doCompile (deep async function with subprocess
// side effects) and effectively unreachable by unit tests. Pulling
// it out into a pure function exposes the security-critical flags
// to direct assertion.
//
// What this file pins:
//   - The exact ordering: --no-shell-escape MUST come BEFORE profile
//     overrides so a hostile $pdflatex override can't enable shell-
//     escape (latexmk has last-wins-for-flags semantics).
//   - Every security flag present, with its literal value.
//   - The engineFlag, jobName, projectDir, mainFile are all
//     positioned correctly in the argv.
//   - profileOverrides are spliced verbatim between -e $max_repeat
//     and -jobname.

import { describe, it, expect } from 'vitest';
import { buildLatexmkArgs } from '../compiler.js';

const baseInput = {
  engineFlag: '-pdf',
  jobName: 'main_abc',
  projectDir: '/srv/flowtex/projects/p1',
  mainFile: 'main.tex',
  profileOverrides: [],
};

describe('buildLatexmkArgs', () => {
  it('produces every security-critical flag in the expected positions', () => {
    const argv = buildLatexmkArgs(baseInput);

    // Engine flag first, mainFile last -- those are the latexmk
    // conventions and break the compile if reordered.
    expect(argv[0]).toBe('-pdf');
    expect(argv[argv.length - 1]).toBe('main.tex');

    // SECURITY: shell-escape is OFF and present BEFORE the position
    // where profileOverrides would land. Mutation testing surfaced
    // that swapping --no-shell-escape -> "" would survive the
    // existing tests, so we now assert both presence and the literal
    // value.
    expect(argv).toContain('--no-shell-escape');
    expect(argv).toContain('-interaction=nonstopmode');
    expect(argv).toContain('-f');
    expect(argv).toContain('-recorder');
    expect(argv).toContain('-synctex=1');
    expect(argv).toContain(`-jobname=${baseInput.jobName}`);
    expect(argv).toContain(`-output-directory=${baseInput.projectDir}`);

    // Recursion / max-repeat cap is the DOS guard; check literally.
    const maxRepeatIdx = argv.indexOf('-e');
    expect(maxRepeatIdx).toBeGreaterThan(0);
    expect(argv[maxRepeatIdx + 1]).toBe('$max_repeat=4');
  });

  it('SECURITY: --no-shell-escape appears BEFORE any profileOverrides position', () => {
    // The whole point of putting --no-shell-escape early is that
    // latexmk uses last-wins for flags. If profileOverrides contained
    // `-e $pdflatex = q[pdflatex %O -shell-escape %S]`, it would lose
    // to the earlier --no-shell-escape only if --no-shell-escape is
    // textually first. Mutation: moving --no-shell-escape AFTER the
    // overrides would silently weaken the sandbox. This test pins the
    // order.
    const argv = buildLatexmkArgs({
      ...baseInput,
      profileOverrides: ['-e', '$pdflatex = q[anything]'],
    });
    const noShellIdx = argv.indexOf('--no-shell-escape');
    const overrideValIdx = argv.indexOf('$pdflatex = q[anything]');
    expect(noShellIdx).toBeGreaterThan(-1);
    expect(overrideValIdx).toBeGreaterThan(-1);
    expect(noShellIdx).toBeLessThan(overrideValIdx);
  });

  it('does NOT include the legacy `--` separator (pinned post-9efa676)', () => {
    // Audit round 21 added `--` between -output-directory and mainFile;
    // turned out latexmk treats `--` as an unknown option (not a
    // getopt-style terminator). Removing it was the fix in commit
    // 9efa676. Regression-pin: it MUST NOT come back.
    const argv = buildLatexmkArgs(baseInput);
    expect(argv).not.toContain('--');
  });

  it('honours the engine flag for xelatex / lualatex', () => {
    expect(buildLatexmkArgs({ ...baseInput, engineFlag: '-xelatex' })[0]).toBe('-xelatex');
    expect(buildLatexmkArgs({ ...baseInput, engineFlag: '-lualatex' })[0]).toBe('-lualatex');
  });

  it('splices profileOverrides verbatim between -e $max_repeat and -jobname', () => {
    const overrides = [
      '-e', '$pdflatex = q[/sentinel/pdflatex-override]',
      '-e', '$biber = q[/sentinel/biber-override]',
    ];
    const argv = buildLatexmkArgs({ ...baseInput, profileOverrides: overrides });
    const firstOverrideIdx = argv.indexOf('$pdflatex = q[/sentinel/pdflatex-override]');
    const jobNameIdx = argv.indexOf(`-jobname=${baseInput.jobName}`);
    expect(firstOverrideIdx).toBeGreaterThan(-1);
    expect(jobNameIdx).toBeGreaterThan(firstOverrideIdx);
    // The override values appear in argv exactly as supplied
    for (const override of overrides) {
      expect(argv).toContain(override);
    }
  });

  it('defaults profileOverrides to an empty array if omitted', () => {
    const argv = buildLatexmkArgs({
      engineFlag: '-pdf',
      jobName: 'j',
      projectDir: '/tmp/x',
      mainFile: 'm.tex',
    });
    // No profile overrides means -e $max_repeat=4 is the only `-e`
    expect(argv.filter((a) => a === '-e').length).toBe(1);
  });

  it('mainFile is the LAST argument (positional)', () => {
    const argv = buildLatexmkArgs({
      ...baseInput,
      profileOverrides: ['-e', '$x = q[y]', '-e', '$y = q[z]'],
    });
    // Even with overrides shoved in, mainFile MUST stay last so
    // latexmk treats it as the positional argument.
    expect(argv.slice(-1)).toEqual(['main.tex']);
  });
});
