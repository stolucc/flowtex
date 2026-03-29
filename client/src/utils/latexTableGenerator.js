export function getMergeAt(merges, r, c) {
  return merges?.find(m => m.row === r && m.col === c) || null;
}

export function isCoveredByMerge(merges, r, c) {
  if (!merges) return false;
  return merges.some(m => {
    if (m.row === r && m.col === c) return false; // origin, not covered
    return r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan;
  });
}

// Returns the merge that covers cell (r,c) — but NOT the origin cell itself
export function getCoveringMerge(merges, r, c) {
  if (!merges) return null;
  return merges.find(m => {
    if (m.row === r && m.col === c) return false; // origin, not covered
    return r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan;
  }) || null;
}

export function extractColParts(spec, maxCols) {
  const parts = [];
  let i = 0, current = '';
  function skipBraces() {
    if (i < spec.length && spec[i] === '{') {
      let d = 1; current += '{'; i++;
      while (i < spec.length && d > 0) {
        if (spec[i] === '{') d++;
        if (spec[i] === '}') d--;
        current += spec[i]; i++;
      }
    }
  }
  while (i < spec.length && parts.length < maxCols) {
    const ch = spec[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('><!@'.includes(ch)) { current += ch; i++; skipBraces(); continue; }
    if ('lcrX'.includes(ch)) { current += ch; i++; parts.push(current); current = ''; continue; }
    if ('pmbPMBLRCSW'.includes(ch) && i + 1 < spec.length && spec[i + 1] === '{') {
      current += ch; i++; skipBraces(); parts.push(current); current = ''; continue;
    }
    // '*' repeat — just treat as raw
    current += ch; i++;
  }
  if (current) { if (parts.length > 0) parts[parts.length - 1] += current; }
  return parts;
}

export default function generateLatexTable({ rows, cols, alignment, borders, headerRow, caption, captionText, label, env, centering, boldHeader, zebra, cells, rawColSpec, longtablePreamble, alignments, merges, vlines }) {
  // Build column spec: preserve original if column count unchanged, otherwise generate new
  let colSpec;
  if (rawColSpec && alignments && alignments.length === cols) {
    // Rebuild from original spec: strip all | then re-add based on current vlines
    const stripped = rawColSpec.replace(/\|/g, '');
    const vl = vlines || Array(cols + 1).fill(false);
    // Parse individual column specs from stripped string
    const colParts = extractColParts(stripped, cols);
    let spec = '';
    for (let c = 0; c < colParts.length; c++) {
      if (vl[c]) spec += '|';
      spec += colParts[c];
    }
    if (vl[colParts.length]) spec += '|';
    colSpec = spec;
  } else {
    // Build per-column spec
    let colSpecs;
    if (env === 'tabularx') {
      colSpecs = Array(cols).fill('X');
    } else {
      // Account for \tabcolsep padding (~6pt per side per column)
      const totalWidth = Math.max(0.5, 0.97 - cols * 0.035);
      const colWidth = (totalWidth / cols).toFixed(2);
      const w = `${colWidth}\\textwidth`;
      if (alignment === 'c') {
        colSpecs = Array(cols).fill(`>{\\centering\\arraybackslash}p{${w}}`);
      } else if (alignment === 'r') {
        colSpecs = Array(cols).fill(`>{\\raggedleft\\arraybackslash}p{${w}}`);
      } else {
        colSpecs = Array(cols).fill(`p{${w}}`);
      }
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
  if (needsFloat && env !== 'longtable') {
    lines.push('\\begin{table}[htbp]');
    if (centering) lines.push('\\centering');
    if (zebra) lines.push('\\rowcolors{2}{gray!10}{}');
    if (caption) lines.push(`\\caption{${capText}}`);
    if (label) lines.push(`\\label{${label || 'tab:mytable'}}`);
  } else {
    if (centering) lines.push('\\begin{center}');
    if (zebra) lines.push('\\rowcolors{2}{gray!10}{}');
  }

  // Add row spacing when using rules (hlines or vlines make tables look cramped)
  const hasAnyRules = hlineTop || hlineAll || hlineHeader || isBooktabs || (vlines && vlines.some(v => v));
  if (hasAnyRules) {
    lines.push('\\renewcommand{\\arraystretch}{1.3}');
  }

  // Begin environment
  if (env === 'tabularx') {
    lines.push(`\\begin{tabularx}{\\textwidth}{${colSpec}}`);
  } else if (env === 'longtable') {
    lines.push(`\\begin{longtable}{${colSpec}}`);
    if (longtablePreamble) {
      // Preserve existing longtable preamble (caption, firsthead, endhead, endfoot, endlastfoot)
      lines.push(longtablePreamble.trim());
    } else {
      if (caption) lines.push(`\\caption{${capText}}`);
      if (label) lines.push(`\\label{${label || 'tab:mytable'}}`);
      if (isBooktabs) lines.push('\\toprule');
      else if (hlineTop) lines.push('\\hline');
    }
  } else {
    lines.push(`\\begin{${env}}{${colSpec}}`);
  }

  if (isBooktabs && env !== 'longtable') lines.push('\\toprule');
  else if (hlineTop && env !== 'longtable') lines.push('\\hline');

  // Rows — preserve existing cell content where available
  // For longtable with preamble, skip the header row (it's already in the preamble)
  const startRow = (longtablePreamble && headerRow) ? 1 : 0;
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
          const leftBar = (c === 0 && vl[0]) ? '|' : '';
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
      let content = (existingRow && c < existingRow.length && existingRow[c] != null) ? existingRow[c] : '';

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
          const leftBar = (c === 0 && vl[0]) ? '|' : '';
          const rightBar = vl[c + merge.colSpan] ? '|' : '';
          const mcolAlign = `${leftBar}${baseAlign}${rightBar}`;
          if (merge.rowSpan > 1) {
            // Use * width (natural) when inside multicolumn; = is unreliable across multiple columns
            content = `\\multicolumn{${merge.colSpan}}{${mcolAlign}}{\\multirow{${merge.rowSpan}}{*}{${content}}}`;
          } else {
            content = `\\multicolumn{${merge.colSpan}}{${mcolAlign}}{${content}}`;
          }
        } else if (merge.rowSpan > 1) {
          content = `\\multirow{${merge.rowSpan}}{=}{${content}}`;
        }
      }

      rowParts.push(content);
    }
    const rowStr = rowParts.join(' & ') + ' \\\\';
    // Determine if any multirow spans cross from this row to the next
    const needsCline = activeMerges.some(m => r >= m.row && r < m.row + m.rowSpan - 1);
    const wantRule = (isHeader && (isBooktabs || hlineHeader)) || (!isHeader && hlineAll && r < rows - 1);
    const isLastRow = r === rows - 1;
    // Bottom rule: always full-width since no multirow can span past the last row
    const wantBottom = isLastRow && !longtablePreamble && (isBooktabs || hlineBottom);

    lines.push(rowStr);

    if (wantRule && needsCline) {
      // Use \cline for columns not covered by an active multirow span
      let c = 0;
      while (c < cols) {
        const spanning = activeMerges.find(m => r >= m.row && r < m.row + m.rowSpan - 1 && c >= m.col && c < m.col + m.colSpan);
        if (spanning) {
          c = spanning.col + spanning.colSpan;
        } else {
          const start = c + 1; // \cline is 1-based
          while (c < cols && !activeMerges.find(m => r >= m.row && r < m.row + m.rowSpan - 1 && c >= m.col && c < m.col + m.colSpan)) c++;
          lines.push(`\\cline{${start}-${c}}`);
        }
      }
    } else if (wantRule) {
      if (isHeader && isBooktabs) lines.push('\\midrule');
      else if (isHeader && hlineHeader) lines.push('\\hline');
      else if (!isHeader && hlineAll && r < rows - 1) lines.push('\\hline');
    }
  }

  if (isBooktabs && !longtablePreamble) lines.push('\\bottomrule');
  else if (hlineBottom && !longtablePreamble) lines.push('\\hline');

  // End environment
  lines.push(`\\end{${env === 'tabularx' ? 'tabularx' : env}}`);

  if (needsFloat && env !== 'longtable') {
    lines.push('\\end{table}');
  } else if (centering && env !== 'longtable') {
    lines.push('\\end{center}');
  }

  // Reset arraystretch if we changed it (float/center groups handle scoping, but be safe for longtable)
  if (hasAnyRules && env === 'longtable') {
    lines.push('\\renewcommand{\\arraystretch}{1.0}');
  }

  return lines.join('\n');
}
