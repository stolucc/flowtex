import React, { useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.ico', '.webp']);
const PDF_EXTS = new Set(['.pdf']);

export function getMimeType(path) {
  const ext = (path || '').split('.').pop().toLowerCase();
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

function getFileExt(path) {
  const dot = (path || '').lastIndexOf('.');
  return dot >= 0 ? path.slice(dot).toLowerCase() : '';
}

export default function BinaryPreview({ file }) {
  const ext = getFileExt(file.path);
  const rawUrl = `/api/projects/files/${file.id}/raw`;
  const isPdf = PDF_EXTS.has(ext);
  const isImage = IMAGE_EXTS.has(ext);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(rawUrl, { credentials: 'include' });
        if (!resp.ok || cancelled) return;
        const buf = await resp.arrayBuffer();
        if (cancelled) return;
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = '';
        const containerWidth = containerRef.current.clientWidth - 32;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const fitScale = containerWidth > 0 ? containerWidth / unscaledViewport.width : 1;
          const scale = Math.max(0.5, Math.min(fitScale, 2));
          const viewport = page.getViewport({ scale });
          const wrapper = document.createElement('div');
          wrapper.className = 'pdf-page-wrapper';
          wrapper.style.width = viewport.width + 'px';
          wrapper.style.marginBottom = '12px';
          const canvas = document.createElement('canvas');
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.display = 'block';
          canvas.style.width = '100%';
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          wrapper.appendChild(canvas);
          containerRef.current.appendChild(wrapper);
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
      } catch (e) {
        if (!cancelled && containerRef.current) {
          containerRef.current.textContent = 'Failed to load PDF';
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id, isPdf, rawUrl]);

  if (isImage) {
    return (
      <div className="binary-preview">
        <div className="binary-preview-label">{file.path}</div>
        <img src={rawUrl} alt={file.path} className="binary-preview-image" />
      </div>
    );
  }
  if (isPdf) {
    return (
      <div className="binary-preview binary-preview-pdf-container">
        <div className="binary-preview-label">{file.path}</div>
        <div className="binary-preview-pdf-pages" ref={containerRef}>
          <p className="binary-preview-unsupported">Loading PDF...</p>
        </div>
      </div>
    );
  }
  return (
    <div className="binary-preview">
      <div className="binary-preview-label">{file.path}</div>
      <p className="binary-preview-unsupported">Binary file — no preview available</p>
    </div>
  );
}
