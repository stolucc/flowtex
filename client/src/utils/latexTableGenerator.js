/**
 * Get the merge definition originating at cell (r, c), or null.
 * @param {Array} merges
 * @param {number} r - Row index
 * @param {number} c - Column index
 * @returns {Object|null}
 */
export function getMergeAt(merges, r, c) {
  return merges?.find((m) => m.row === r && m.col === c) || null;
}

/**
 * Check if cell (r, c) is covered by a merge but is not the merge origin.
 * @param {Array} merges
 * @param {number} r - Row index
 * @param {number} c - Column index
 * @returns {boolean}
 */
export function isCoveredByMerge(merges, r, c) {
  if (!merges) return false;
  return merges.some((m) => {
    if (m.row === r && m.col === c) return false; // origin, not covered
    return r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan;
  });
}

/**
 * Return the merge that covers cell (r, c), excluding the origin cell itself.
 * @param {Array} merges
 * @param {number} r - Row index
 * @param {number} c - Column index
 * @returns {Object|null}
 */
function getCoveringMerge(merges, r, c) {
  if (!merges) return null;
  return (
    merges.find((m) => {
      if (m.row === r && m.col === c) return false; // origin, not covered
      return r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan;
    }) || null
  );
}

/**
 * Generate LaTeX source for a table from structured options.
 * @param {Object} options - Table configuration (rows, cols, colSettings, borders, cells, merges, etc.)
 * @returns {string} LaTeX source string
 */
export default function generateLatexTable({
  rows,
  cols,
  colSettings,
  borders,
  headerRow,
  caption,
  captionPos = 'top',
  captionVAlign = 'center',
  captionText,
  label,
  env,
  placement = 'htbp',
  centering,
  boldHeader,
  zebra,
  cells,
  longtablePreamble,
  merges,
  vlines,
  booktabsSep,
  clines,
}) {
  // Build column spec from per-column settings
  const sideCaption = (captionPos === 'left' || captionPos === 'right') && env !== 'longtable';
  // Derive a default alignment for multicolumn/multirow fallback
  const alignment = colSettings?.[0]?.align || 'c';
  let colSpec;
  {
    let colSpecs;
    if (env === 'tabularx') {
      colSpecs = Array(cols).fill('X');
    } else {
      colSpecs = Array.from({ length: cols }, (_, i) => {
        const cs = colSettings?.[i] || { align: 'c' };
        if (cs.align === 'p' && cs.width) {
          return `p{${cs.width}}`;
        }
        return cs.align || 'l';
      });
    }
    // Interleave with vertical lines
    const vl = vlines || Array(cols + 1).fill(false);
    let spec = '';
    for (let c = 0; c < cols; c++) {
      if (vl[c]) spec += '|';
      spec += colSpecs[c];
    }
    if (vl[cols]) spec += '|';
    colSpec = spec;
  }
  const isBooktabs = borders === 'booktabs';
  const hlineTop = !isBooktabs && (borders === 'outside' || borders === 'header' || borders === 'all');
  const hlineBottom = hlineTop;
  const hlineHeader = !isBooktabs && (borders === 'header' || borders === 'all');
  const hlineAll = !isBooktabs && borders === 'all';
  const capText = captionText || 'Caption here';

  const lines = [];

  // Preamble — float wrapper
  const needsFloat = caption || label;
  const isSide = (captionPos === 'left' || captionPos === 'right') && env !== 'longtable' && needsFloat;
  if (needsFloat && env !== 'longtable') {
    if (isSide) {
      // floatrow package: \ttabbox with capposition=beside
      lines.push(`\\begin{table}[${placement}]`);
      lines.push(`\\floatsetup{capposition=beside,capbesideposition={${captionPos},${captionVAlign}}}`);
      if (zebra) lines.push('\\rowcolors{2}{gray!10}{}');
      // \ttabbox{caption}{tabular} — caption and tabular go inside handleInsert closing
    } else {
      if (captionPos === 'bottom') {
        lines.push('\\begingroup\\floatsetup[table]{capposition=bottom}');
      }
      lines.push(`\\begin{table}[${placement}]`);
      if (centering) lines.push('\\centering');
      if (zebra) lines.push('\\rowcolors{2}{gray!10}{}');
      if (caption && captionPos !== 'bottom') lines.push(`\\caption{${capText}}`);
      if (label && captionPos !== 'bottom') lines.push(`\\label{${label || 'tab:mytable'}}`);
    }
  } else {
    if (zebra) lines.push('\\rowcolors{2}{gray!10}{}');
  }

  // Add row spacing when using rules (hlines or vlines make tables look cramped)
  const hasAnyRules = hlineTop || hlineAll || hlineHeader || isBooktabs || (vlines && vlines.some((v) => v));
  if (hasAnyRules) {
    lines.push('\\renewcommand{\\arraystretch}{1.3}');
  }

  // Side caption: wrap in \ttabbox{caption}{tabular}
  if (isSide) {
    let capBlock = '';
    if (caption) capBlock += `\\caption{${capText}}`;
    if (label) capBlock += `\\label{${label || 'tab:mytable'}}`;
    lines.push(`\\ttabbox{${capBlock}}{%`);
  }

  // Begin environment
  if (env === 'tabularx') {
    const tabularxWidth = sideCaption ? '0.55\\textwidth' : '\\textwidth';
    lines.push(`\\begin{tabularx}{${tabularxWidth}}{${colSpec}}`);
  } else if (env === 'longtable') {
    // longtable uses [c], [l], or [r] for horizontal alignment, not [htbp]
    const ltAlign = placement === 'l' || placement === 'r' ? placement : 'c';
    lines.push(`\\begin{longtable}[${ltAlign}]{${colSpec}}`);
    if (longtablePreamble) {
      // Preserve existing longtable preamble (caption, firsthead, endhead, endfoot, endlastfoot)
      lines.push(longtablePreamble.trim());
    } else {
      // Build the header row content for reuse in firsthead/endhead
      const headerParts = [];
      if (headerRow) {
        for (let c = 0; c < cols; c++) {
          const existingRow = cells && cells[0];
          let content = existingRow && c < existingRow.length && existingRow[c] != null ? existingRow[c] : '';
          if (content) {
            if (boldHeader && !/\\textbf\{/.test(content)) content = `\\textbf{${content}}`;
            else if (!boldHeader && /\\textbf\{/.test(content)) content = content.replace(/\\textbf\{(.*?)\}/, '$1');
          } else {
            const text = `Header ${c + 1}`;
            content = boldHeader ? `\\textbf{${text}}` : text;
          }
          headerParts.push(content);
        }
      }
      const headerLine = headerParts.join(' & ') + ' \\\\';
      const topRule = isBooktabs ? '\\toprule' : (hlineTop ? '\\hline' : '');
      const midRule = isBooktabs ? '\\midrule' : (hlineHeader ? '\\hline' : '');

      // \endfirsthead — first page header with full caption
      if (caption) lines.push(`\\caption{${capText}}`);
      if (label) lines.push(`\\label{${label || 'tab:mytable'}}`);
      if (caption || label) lines.push('\\\\');
      if (topRule) lines.push(topRule);
      if (headerRow) {
        lines.push(headerLine);
        if (midRule) lines.push(midRule);
      }
      lines.push('\\endfirsthead');

      // \endhead — continuation pages header
      if (topRule) lines.push(topRule);
      if (headerRow) {
        lines.push(headerLine);
        if (midRule) lines.push(midRule);
      }
      lines.push('\\endhead');

      // \endfoot — bottom of each page (except last)
      if (isBooktabs) lines.push('\\midrule');
      else if (hlineBottom) lines.push('\\hline');
      lines.push('\\endfoot');

      // \endlastfoot — bottom of last page
      if (isBooktabs) lines.push('\\bottomrule');
      else if (hlineBottom) lines.push('\\hline');
      lines.push('\\endlastfoot');
    }
  } else {
    lines.push(`\\begin{${env}}{${colSpec}}`);
  }

  if (isBooktabs && env !== 'longtable') lines.push('\\toprule');
  else if (hlineTop && env !== 'longtable') lines.push('\\hline');

  // Rows — preserve existing cell content where available
  // For longtable, skip the header row (it's in the preamble sections)
  const startRow = env === 'longtable' && headerRow ? 1 : 0;
  const activeMerges = merges || [];
  for (let r = startRow; r < rows; r++) {
    const isHeader = headerRow && r === 0;
    const existingRow = cells && cells[r];
    const rowParts = [];
    for (let c = 0; c < cols; c++) {
      // Check if this cell is covered by a merge (not the origin)
      const coveringMerge = getCoveringMerge(activeMerges, r, c);
      if (coveringMerge) {
        // For multi-row merges that also span columns, subsequent rows need
        // an empty \multicolumn placeholder to keep column alignment correct.
        // Only emit the placeholder at the first covered column of the merge in this row.
        if (coveringMerge.colSpan > 1 && c === coveringMerge.col) {
          const vl = vlines || [];
          const leftBar = c === 0 && vl[0] ? '|' : '';
          const rightBar = vl[c + coveringMerge.colSpan] ? '|' : '';
          const baseAlign = (coveringMerge.align || alignment).replace(/\|/g, '');
          const mcolAlign = `${leftBar}${baseAlign}${rightBar}`;
          rowParts.push(`\\multicolumn{${coveringMerge.colSpan}}{${mcolAlign}}{}`);
        }
        // For single-column multirow, just push an empty cell
        else if (coveringMerge.colSpan === 1 && c === coveringMerge.col) {
          rowParts.push('');
        }
        // Otherwise skip (additional columns consumed by the multicolumn)
        continue;
      }

      const merge = getMergeAt(activeMerges, r, c);
      let content = existingRow && c < existingRow.length && existingRow[c] != null ? existingRow[c] : '';

      // Handle bold header toggle
      if (isHeader && content) {
        if (boldHeader && !/\\textbf\{/.test(content)) {
          content = `\\textbf{${content}}`;
        } else if (!boldHeader && /\\textbf\{/.test(content)) {
          content = content.replace(/\\textbf\{(.*?)\}/, '$1');
        }
      } else if (isHeader && !content) {
        const text = `Header ${c + 1}`;
        content = boldHeader ? `\\textbf{${text}}` : text;
      }

      if (merge) {
        // Wrap content in \multicolumn / \multirow as needed
        const baseAlign = (merge.align || alignment).replace(/\|/g, '');
        if (merge.colSpan > 1) {
          // Build multicolumn alignment spec with vlines
          const vl = vlines || [];
          const leftBar = c === 0 && vl[0] ? '|' : '';
          const rightBar = vl[c + merge.colSpan] ? '|' : '';
          const mcolAlign = `${leftBar}${baseAlign}${rightBar}`;
          if (merge.rowSpan > 1) {
            // Use * width (natural) when inside multicolumn; = is unreliable across multiple columns
            content = `\\multicolumn{${merge.colSpan}}{${mcolAlign}}{\\multirow{${merge.rowSpan}}{*}{${content}}}`;
          } else {
            content = `\\multicolumn{${merge.colSpan}}{${mcolAlign}}{${content}}`;
          }
        } else if (merge.rowSpan > 1) {
          // Use '=' (column width) for p{} columns where text should wrap;
          // use '*' (natural width) for l/c/r columns which have no fixed width
          const cs = colSettings?.[c];
          const mrWidth = (cs?.align === 'p' && cs?.width) ? '=' : '*';
          content = `\\multirow{${merge.rowSpan}}{${mrWidth}}{${content}}`;
        }
      }

      rowParts.push(content);
    }
    const rowStr = rowParts.join(' & ') + ' \\\\';
    // Determine if any multirow spans cross from this row to the next
    const needsCline = activeMerges.some((m) => r >= m.row && r < m.row + m.rowSpan - 1);
    const wantRule = (isHeader && (isBooktabs || hlineHeader)) || (!isHeader && hlineAll && r < rows - 1);
    const isLastRow = r === rows - 1;

    lines.push(rowStr);

    if (wantRule && needsCline) {
      // Use \cline for columns not covered by an active multirow span
      let c = 0;
      while (c < cols) {
        const spanning = activeMerges.find(
          (m) => r >= m.row && r < m.row + m.rowSpan - 1 && c >= m.col && c < m.col + m.colSpan,
        );
        if (spanning) {
          c = spanning.col + spanning.colSpan;
        } else {
          const start = c + 1; // \cline is 1-based
          while (
            c < cols &&
            !activeMerges.find((m) => r >= m.row && r < m.row + m.rowSpan - 1 && c >= m.col && c < m.col + m.colSpan)
          )
            c++;
          lines.push(`\\cline{${start}-${c}}`);
        }
      }
    } else if (wantRule) {
      if (isHeader && isBooktabs) lines.push('\\midrule');
      else if (isHeader && hlineHeader) lines.push('\\hline');
      else if (!isHeader && hlineAll && r < rows - 1) lines.push('\\hline');
    }
    // Booktabs body-row separator (between non-header rows, not after last row)
    if (isBooktabs && !isHeader && !isLastRow && booktabsSep && booktabsSep !== 'none' && !needsCline) {
      if (booktabsSep === 'midrule') lines.push('\\midrule');
      else if (booktabsSep === 'addlinespace') lines.push('\\addlinespace');
    }

    // User-defined partial horizontal rules (\cline or \cmidrule)
    const activeClines = clines || [];
    const rowClines = activeClines.filter((cl) => cl.row === r);
    for (const cl of rowClines) {
      const from = cl.fromCol + 1; // 1-based
      const to = cl.toCol + 1;
      if (isBooktabs) {
        const trim = cl.trim ? `(${cl.trim})` : '';
        lines.push(`\\cmidrule${trim}{${from}-${to}}`);
      } else {
        lines.push(`\\cline{${from}-${to}}`);
      }
    }
  }

  // longtable bottom rule is in \endlastfoot; for preserved preamble, also skip
  if (env !== 'longtable') {
    if (isBooktabs) lines.push('\\bottomrule');
    else if (hlineBottom) lines.push('\\hline');
  }

  // End environment
  lines.push(`\\end{${env === 'tabularx' ? 'tabularx' : env}}`);

  if (needsFloat && env !== 'longtable') {
    if (isSide) {
      // Close \ttabbox second brace
      lines.push('}');
    } else {
      if (caption && captionPos === 'bottom') lines.push(`\\caption{${capText}}`);
      if (label && captionPos === 'bottom') lines.push(`\\label{${label || 'tab:mytable'}}`);
    }
    lines.push('\\end{table}');
    if (captionPos === 'bottom') {
      lines.push('\\endgroup');
    }
  }

  // Reset arraystretch if we changed it (float/center groups handle scoping, but be safe for longtable)
  if (hasAnyRules && env === 'longtable') {
    lines.push('\\renewcommand{\\arraystretch}{1.0}');
  }

  return lines.join('\n');
}
