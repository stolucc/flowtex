/**
 * Generate LaTeX source for a figure environment from structured options.
 * @param {Object} options - Figure configuration (env, placement, imagePath, width, caption, label, etc.)
 * @returns {string} LaTeX source string
 */
export default function generateLatexFigure({
  env = 'figure',
  placement = 'htbp',
  imagePath = '',
  width = '0.8',
  widthUnit = 'textwidth',
  caption,
  captionText,
  label,
  centering = true,
  captionPos = 'bottom',
  captionVAlign = 'center',
}) {
  const lines = [];
  const capText = captionText || 'Caption here';
  const needsFloat = caption || label;
  const isSide = captionPos === 'left' || captionPos === 'right';

  // Width spec for \includegraphics
  let widthSpec;
  if (widthUnit === 'textwidth' || widthUnit === 'linewidth' || widthUnit === 'columnwidth') {
    widthSpec = `width=${width}\\${widthUnit}`;
  } else {
    widthSpec = `width=${width}${widthUnit}`;
  }

  const imgLine = `\\includegraphics[${widthSpec}]{${imagePath}}`;

  if (isSide && needsFloat) {
    lines.push(`\\begin{${env}}[${placement}]`);
    lines.push(`\\thisfloatsetup{capposition=beside,capbesideposition={${captionPos},${captionVAlign}}}`);
    let capBlock = '';
    if (caption) capBlock += `\\caption{${capText}}`;
    if (label) capBlock += `\\label{${label}}`;
    lines.push(`\\fcapside[\\FBwidth]`);
    lines.push(`{${imgLine}}`);
    lines.push(`{${capBlock}}`);
    lines.push(`\\end{${env}}`);
  } else {
    // floatrow defaults to capposition=bottom for figures;
    // top captions need a local override via \begingroup scoping
    if (needsFloat && captionPos === 'top') {
      lines.push('\\begingroup\\floatsetup[figure]{capposition=top}');
    }
    lines.push(`\\begin{${env}}[${placement}]`);
    if (centering) lines.push('\\centering');
    if (caption && captionPos === 'top') lines.push(`\\caption{${capText}}`);
    if (label && captionPos === 'top') lines.push(`\\label{${label}}`);
    lines.push(imgLine);
    if (caption && captionPos !== 'top') lines.push(`\\caption{${capText}}`);
    if (label && captionPos !== 'top') lines.push(`\\label{${label}}`);
    lines.push(`\\end{${env}}`);
    if (needsFloat && captionPos === 'top') {
      lines.push('\\endgroup');
    }
  }

  return lines.join('\n');
}
