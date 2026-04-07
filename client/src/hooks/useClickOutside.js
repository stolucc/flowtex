import { useEffect } from 'react';

/**
 * Triggers a handler when a click occurs outside the referenced element.
 * @param {import('react').RefObject} ref - Ref to the element to monitor.
 * @param {Function} handler - Callback invoked on outside click.
 * @param {boolean} [active=true] - Whether the listener is active.
 */
export default function useClickOutside(ref, handler, active = true) {
  useEffect(() => {
    if (!active) return;
    const listener = (e) => {
      if (ref.current && !ref.current.contains(e.target)) handler();
    };
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [ref, handler, active]);
}
