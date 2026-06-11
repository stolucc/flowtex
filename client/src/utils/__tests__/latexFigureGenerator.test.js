import { describe, it, expect } from 'vitest';
import generateLatexFigure from '../latexFigureGenerator.js';

describe('generateLatexFigure', () => {
  it('default options produce a minimal figure with centering and no caption/label', () => {
    const out = generateLatexFigure({});
    expect(out).toBe(
      [
        '\\begin{figure}[htbp]',
        '\\centering',
        '\\includegraphics[width=0.8\\textwidth]{}',
        '\\end{figure}',
      ].join('\n'),
    );
  });

  it('omits \\centering when centering=false', () => {
    const out = generateLatexFigure({ centering: false });
    expect(out.split('\n')).not.toContain('\\centering');
  });

  it('uses the supplied imagePath inside \\includegraphics{...}', () => {
    const out = generateLatexFigure({ imagePath: 'figs/foo.png' });
    expect(out).toContain('\\includegraphics[width=0.8\\textwidth]{figs/foo.png}');
  });

  it('width-unit textwidth/linewidth/columnwidth get a backslash prefix in the spec', () => {
    expect(generateLatexFigure({ width: '0.5', widthUnit: 'textwidth' })).toContain('width=0.5\\textwidth');
    expect(generateLatexFigure({ width: '0.5', widthUnit: 'linewidth' })).toContain('width=0.5\\linewidth');
    expect(generateLatexFigure({ width: '0.5', widthUnit: 'columnwidth' })).toContain('width=0.5\\columnwidth');
  });

  it('absolute-length width units appear bare (no backslash, no space)', () => {
    expect(generateLatexFigure({ width: '5', widthUnit: 'cm' })).toContain('width=5cm');
    expect(generateLatexFigure({ width: '120', widthUnit: 'pt' })).toContain('width=120pt');
  });

  it('caption=true uses default caption text "Caption here"', () => {
    const out = generateLatexFigure({ caption: true });
    expect(out).toContain('\\caption{Caption here}');
  });

  it('caption=true + custom captionText uses the custom text', () => {
    const out = generateLatexFigure({ caption: true, captionText: 'My figure caption' });
    expect(out).toContain('\\caption{My figure caption}');
  });

  it('label without caption still triggers float wrapping and emits \\label', () => {
    // needsFloat = caption || label, so a label alone is enough.
    const out = generateLatexFigure({ label: 'fig:foo' });
    expect(out).toContain('\\label{fig:foo}');
    expect(out).toContain('\\begin{figure}[htbp]');
    expect(out).not.toContain('\\caption');
  });

  it('caption + label are placed AFTER the image when captionPos="bottom" (default)', () => {
    const out = generateLatexFigure({ caption: true, label: 'fig:foo' });
    const lines = out.split('\n');
    const img = lines.findIndex((l) => l.startsWith('\\includegraphics'));
    const cap = lines.findIndex((l) => l.startsWith('\\caption'));
    const lab = lines.findIndex((l) => l.startsWith('\\label'));
    expect(cap).toBeGreaterThan(img);
    expect(lab).toBeGreaterThan(img);
  });

  it('caption + label are placed BEFORE the image when captionPos="top"', () => {
    const out = generateLatexFigure({ caption: true, label: 'fig:foo', captionPos: 'top' });
    const lines = out.split('\n');
    const img = lines.findIndex((l) => l.startsWith('\\includegraphics'));
    const cap = lines.findIndex((l) => l.startsWith('\\caption'));
    const lab = lines.findIndex((l) => l.startsWith('\\label'));
    expect(cap).toBeLessThan(img);
    expect(lab).toBeLessThan(img);
  });

  it('captionPos="top" wraps the env in \\begingroup\\floatsetup[figure]{capposition=top} … \\endgroup', () => {
    const out = generateLatexFigure({ caption: true, captionPos: 'top' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('\\begingroup\\floatsetup[figure]{capposition=top}');
    expect(lines[lines.length - 1]).toBe('\\endgroup');
  });

  it('top-position scope is NOT added when no caption AND no label is set', () => {
    const out = generateLatexFigure({ captionPos: 'top' });
    expect(out).not.toContain('\\begingroup');
    expect(out).not.toContain('\\endgroup');
  });

  it('captionPos="left" + caption produces the side-caption (\\fcapside) form', () => {
    const out = generateLatexFigure({
      caption: true,
      captionText: 'Side cap',
      captionPos: 'left',
      captionVAlign: 'top',
    });
    expect(out).toContain('\\thisfloatsetup{capposition=beside,capbesideposition={left,top}}');
    expect(out).toContain('\\fcapside[\\FBwidth]');
    expect(out).toContain('{\\caption{Side cap}}');
  });

  it('captionPos="right" produces side-caption with right alignment', () => {
    const out = generateLatexFigure({
      caption: true,
      captionPos: 'right',
      captionVAlign: 'bottom',
    });
    expect(out).toContain('capbesideposition={right,bottom}');
  });

  it('side-caption form with label-only (no caption) emits empty capBlock with \\label', () => {
    const out = generateLatexFigure({ label: 'fig:side', captionPos: 'left' });
    expect(out).toContain('\\fcapside[\\FBwidth]');
    expect(out).toContain('{\\label{fig:side}}');
  });

  it('custom env (e.g. "subfigure") is reflected in both \\begin and \\end', () => {
    const out = generateLatexFigure({ env: 'subfigure' });
    expect(out).toContain('\\begin{subfigure}[htbp]');
    expect(out).toContain('\\end{subfigure}');
  });

  it('custom placement (e.g. "H") replaces the default "htbp"', () => {
    const out = generateLatexFigure({ placement: 'H' });
    expect(out).toContain('\\begin{figure}[H]');
  });
});
