// @ts-check
import { useEffect } from 'react';

/**
 * Triggers a handler when a click occurs outside the referenced element.
 * @param {import('react').RefObject<HTMLElement | null>} ref - Ref to the element to monitor.
 * @param {() => void} handler - Callback invoked on outside click.
 * @param {boolean} [active=true] - Whether the listener is active.
 */
export default function useClickOutside(ref, handler, active = true) {
  useEffect(() => {
    if (!active) return;
    const listener = (/** @type {MouseEvent} */ e) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) handler();
    };
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [ref, handler, active]);
}
