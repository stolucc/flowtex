import { useEffect } from 'react';

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
