import { describe, it, expect } from 'vitest';
import { RAIL_HEADER_HEIGHT, shouldShowRailMarker } from '../commentsRail.js';

describe('shouldShowRailMarker', () => {
  it('hides markers above the header zone', () => {
    expect(shouldShowRailMarker(0)).toBe(false);
    expect(shouldShowRailMarker(10)).toBe(false);
    expect(shouldShowRailMarker(RAIL_HEADER_HEIGHT - 1)).toBe(false);
  });

  it('shows markers at or below the header zone', () => {
    expect(shouldShowRailMarker(RAIL_HEADER_HEIGHT)).toBe(true);
    expect(shouldShowRailMarker(RAIL_HEADER_HEIGHT + 1)).toBe(true);
    expect(shouldShowRailMarker(500)).toBe(true);
  });

  it('hides markers with negative top (scrolled above viewport)', () => {
    expect(shouldShowRailMarker(-5)).toBe(false);
    expect(shouldShowRailMarker(-1000)).toBe(false);
  });

  it('rejects non-numeric tops defensively', () => {
    expect(shouldShowRailMarker(null)).toBe(false);
    expect(shouldShowRailMarker(undefined)).toBe(false);
    expect(shouldShowRailMarker('30')).toBe(false);
    expect(shouldShowRailMarker(NaN)).toBe(false);
  });

  it('accepts a custom headerHeight', () => {
    expect(shouldShowRailMarker(20, 16)).toBe(true);
    expect(shouldShowRailMarker(20, 30)).toBe(false);
  });
});
