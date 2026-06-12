// @ts-check
import { useEffect, useRef, useState } from 'react';
import { lookupCommandPackage } from '../utils/commandPackageLookup.js';
import {
  setDynamicCommandPackages,
  getDynamicCommandPackages,
  getCommandPackage,
} from '../utils/latexErrorHelp.js';

const UNDEF_CMD_RE = /Undefined control sequence.*\\(\w+)/i;

/**
 * Given the compile error list, kick off background lookups for every
 * undefined-command error whose `\X` isn't already in the static map
 * AND hasn't been resolved by a previous dynamic lookup. When a lookup
 * resolves, mutate the shared dynamic map and re-render the panel so
 * the new Fix button appears.
 *
 * No-ops when there are no errors to warm.
 *
 * Returns a `version` integer that bumps every time the dynamic map
 * gains a new entry. Components consuming getErrorHelp() should read
 * it via this hook (or a sibling state) so React knows to re-render.
 *
 * @param {Array<{ text?: string, message?: string }>} errors
 * @returns {number}
 */
export default function useCommandPackageWarming(errors) {
  const [version, setVersion] = useState(0);
  // Track which commands are CURRENTLY being looked up so we don't
  // fire duplicate fetches for the same command in the same render.
  /** @type {React.MutableRefObject<Set<string>>} */
  const inFlightRef = useRef(new Set());

  useEffect(() => {
    if (!Array.isArray(errors) || errors.length === 0) return;
    // Extract \cmd names from undefined-command errors.
    /** @type {Set<string>} */
    const needed = new Set();
    for (const e of errors) {
      const text = e?.text || e?.message || '';
      const m = UNDEF_CMD_RE.exec(text);
      if (!m) continue;
      const cmd = m[1];
      if (!cmd) continue;
      // Skip if static map or dynamic map already knows the answer
      // (including null/built-in entries).
      if (getCommandPackage(cmd) !== undefined) continue;
      if (inFlightRef.current.has(cmd)) continue;
      needed.add(cmd);
    }
    if (needed.size === 0) return;

    let cancelled = false;
    for (const cmd of needed) {
      inFlightRef.current.add(cmd);
      lookupCommandPackage(cmd).then((res) => {
        if (cancelled) {
          inFlightRef.current.delete(cmd);
          return;
        }
        // Merge into the dynamic map. Build a NEW map so React state
        // updaters that compare references see a change.
        const cur = getDynamicCommandPackages();
        const next = new Map(cur);
        next.set(cmd, res.package);
        setDynamicCommandPackages(next);
        inFlightRef.current.delete(cmd);
        setVersion((v) => v + 1);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [errors]);

  return version;
}
