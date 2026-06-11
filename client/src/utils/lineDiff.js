// @ts-check
/**
 * Line-based diff using a hunt-and-match approach.
 * Returns array of { type: 'same'|'add'|'remove', text: string }
 */
/**
 * @typedef {{ type: 'same' | 'add' | 'remove', text: string }} DiffLine
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {DiffLine[]}
 */
export default function lineDiff(oldText, newText) {
  if (oldText === newText) {
    return oldText.split('\n').map((/** @type {string} */ text) => ({ type: 'same', text }));
  }

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  // Use LCS for small files
  if (m * n <= 10000000) {
    return lcsLineDiff(oldLines, newLines, m, n);
  }

  // For large files, use a hash-based patience-like approach
  return hashLineDiff(oldLines, newLines);
}

/**
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @param {number} m
 * @param {number} n
 * @returns {DiffLine[]}
 */
function lcsLineDiff(oldLines, newLines, m, n) {
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i * w + j] = dp[(i + 1) * w + (j + 1)] + 1;
      } else {
        dp[i * w + j] = Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
      }
    }
  }

  /** @type {DiffLine[]} */
  const result = [];
  let i = 0,
    j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      result.push({ type: 'same', text: oldLines[i] });
      i++;
      j++;
    } else if (j < n && (i >= m || dp[i * w + (j + 1)] >= dp[(i + 1) * w + j])) {
      result.push({ type: 'add', text: newLines[j] });
      j++;
    } else {
      result.push({ type: 'remove', text: oldLines[i] });
      i++;
    }
  }
  return result;
}

/**
 * Hash-based diff for large files. Finds unique matching lines as anchors,
 * then recursively diffs the gaps between anchors.
 */
/**
 * @param {string[]} oldLines
 * @param {string[]} newLines
 * @returns {DiffLine[]}
 */
function hashLineDiff(oldLines, newLines) {
  // Build map of line content → positions in each file
  /** @type {Map<string, number[]>} */
  const oldMap = new Map();
  for (let i = 0; i < oldLines.length; i++) {
    const line = oldLines[i];
    if (!oldMap.has(line)) oldMap.set(line, []);
    /** @type {number[]} */ (oldMap.get(line)).push(i);
  }

  // First pass: find unique-in-both-sides anchors (patience diff idea)
  /** @type {Map<string, number>} */
  const newCount = new Map();
  for (const line of newLines) {
    newCount.set(line, (newCount.get(line) || 0) + 1);
  }

  /** @type {Array<[number, number]>} */
  const anchors = [];
  for (let j = 0; j < newLines.length; j++) {
    const line = newLines[j];
    const oldPositions = oldMap.get(line);
    if (oldPositions && oldPositions.length === 1 && newCount.get(line) === 1) {
      anchors.push([oldPositions[0], j]);
    }
  }

  // Sort anchors by old position and find LIS by new position
  anchors.sort((a, b) => a[0] - b[0]);
  const lis = longestIncreasingSubseq(anchors.map((a) => a[1]));
  const anchorMatches = lis.map((idx) => anchors[idx]);

  // Now recursively diff between anchors
  /** @type {DiffLine[]} */
  const result = [];
  let oi = 0,
    ni = 0;

  for (const [ao, an] of anchorMatches) {
    // Diff the gap before this anchor
    const oldSlice = oldLines.slice(oi, ao);
    const newSlice = newLines.slice(ni, an);
    if (oldSlice.length > 0 || newSlice.length > 0) {
      if (oldSlice.length * newSlice.length <= 10000000) {
        result.push(...lcsLineDiff(oldSlice, newSlice, oldSlice.length, newSlice.length));
      } else {
        result.push(...oldSlice.map((/** @type {string} */ text) => /** @type {DiffLine} */ ({ type: 'remove', text })));
        result.push(...newSlice.map((/** @type {string} */ text) => /** @type {DiffLine} */ ({ type: 'add', text })));
      }
    }
    // The anchor itself
    result.push({ type: 'same', text: oldLines[ao] });
    oi = ao + 1;
    ni = an + 1;
  }

  // Diff remaining tail
  const oldTail = oldLines.slice(oi);
  const newTail = newLines.slice(ni);
  if (oldTail.length > 0 || newTail.length > 0) {
    if (oldTail.length * newTail.length <= 10000000) {
      result.push(...lcsLineDiff(oldTail, newTail, oldTail.length, newTail.length));
    } else {
      result.push(...oldTail.map((/** @type {string} */ text) => /** @type {DiffLine} */ ({ type: 'remove', text })));
      result.push(...newTail.map((/** @type {string} */ text) => /** @type {DiffLine} */ ({ type: 'add', text })));
    }
  }

  return result;
}

/** Find longest increasing subsequence indices */
/**
 * @param {number[]} arr
 * @returns {number[]}
 */
function longestIncreasingSubseq(arr) {
  if (arr.length === 0) return [];
  /** @type {number[]} */
  const tails = []; // tails[i] = smallest tail of IS of length i+1
  /** @type {number[]} */
  const indices = []; // indices[i] = index in arr of tails[i]
  const prev = new Array(arr.length).fill(-1);

  for (let i = 0; i < arr.length; i++) {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < arr[i]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = arr[i];
    indices[lo] = i;
    prev[i] = lo > 0 ? indices[lo - 1] : -1;
  }

  // Reconstruct
  /** @type {number[]} */
  const result = [];
  let k = indices[tails.length - 1];
  for (let i = tails.length - 1; i >= 0; i--) {
    result.push(k);
    k = prev[k];
  }
  result.reverse();
  return result;
}
