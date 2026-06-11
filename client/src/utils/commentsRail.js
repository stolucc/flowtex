// @ts-check
// Pixel height of the collapsed comments rail "header" — the speech-
// bubble icon + count badge at the top. Per-comment markers below this
// y in rail coordinates would visually overlap the icon/badge cluster,
// so we hide them. Numbers correspond to the CSS in app.css:
//   8px  rail padding-top
//  16px  comments-rail-icon height
//   2px  comments-badge margin-top
//  14px  comments-badge line-height-ish height
//   4px  visual gap so a marker doesn't touch the badge
//  ----
//  44px
export const RAIL_HEADER_HEIGHT = 44;

/**
 * True iff a comment marker at the given y (in rail-local coordinates,
 * which match editor-viewport y) should be rendered. Markers whose top
 * is within the rail header zone get hidden so they don't paint over
 * the speech-bubble icon and the count badge.
 */
/**
 * @param {unknown} top
 * @param {number} [headerHeight]
 */
export function shouldShowRailMarker(top, headerHeight = RAIL_HEADER_HEIGHT) {
  return typeof top === 'number' && top >= headerHeight;
}
