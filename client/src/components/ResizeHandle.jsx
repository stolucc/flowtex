import React, { useCallback, useRef } from 'react';

export default function ResizeHandle({ onResize }) {
  const startXRef = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    startXRef.current = e.clientX;

    const onMouseMove = (e) => {
      const delta = e.clientX - startXRef.current;
      startXRef.current = e.clientX;
      onResize(delta);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [onResize]);

  return (
    <div className="resize-handle" onMouseDown={onMouseDown} />
  );
}
