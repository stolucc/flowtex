// HelperStatusBadge: one-line indicator of the helpers state, reused
// in Account Settings → Compile and Project Settings → Compiler.
//
// Reads from HelperStatusContext so every place that renders the badge
// reflects the same probe result, with no extra polling, no extra
// state.
//
// Variants via `size`:
//   'normal' (default) — fits a settings panel row.
//   'small'            — tighter padding + smaller dot for inline use
//                        next to existing form fields.

import React from 'react';
import { useHelperStatusContext } from '../contexts/HelperStatusContext.jsx';

const COLOR_OK = '#16a34a';
const COLOR_WARN = '#f59e0b';
const COLOR_FAIL = '#ef4444';
const COLOR_PENDING = 'var(--text-muted)';

export default function HelperStatusBadge({ size = 'normal' }) {
  const { status } = useHelperStatusContext();
  const fontSize = size === 'small' ? 12 : 13;

  // Display state precedence: loading first (initial probe, no info
  // yet), then the resolved states.
  let dotColor = COLOR_PENDING;
  let label = 'Checking…';
  let detail = '';

  if (status.loading && !status.available && !status.error) {
    dotColor = COLOR_PENDING;
    label = 'Detecting helper…';
  } else if (status.available) {
    dotColor = COLOR_OK;
    label = `Paired. TeX Live ${status.year || '?'}`;
    if (status.enginesAvailable && status.enginesAvailable.length > 0) {
      detail = ` (${status.enginesAvailable.join(', ')})`;
    }
  } else if (status.error === 'unpaired') {
    dotColor = COLOR_WARN;
    label = 'Helper is running but not paired with this browser';
  } else if (status.error === 'unreachable') {
    dotColor = COLOR_FAIL;
    label = 'Helper not detected';
  } else {
    // Default — feature off or just-initialized hook with no info.
    dotColor = COLOR_PENDING;
    label = 'Helper status unknown';
  }

  return (
    <span style={{ fontSize, lineHeight: 1.4 }}>
      <span style={{ color: dotColor, marginRight: 6 }}>●</span>
      {label}
      {detail && <span style={{ color: 'var(--text-muted)' }}>{detail}</span>}
    </span>
  );
}
