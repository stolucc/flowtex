import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import useClickOutside from '../hooks/useClickOutside.js';
import {
  ChevronLeftIcon,
  SearchIcon,
  DropdownCaretIcon,
  RedoIcon,
  TrashIcon,
  DownloadIcon,
  ZoomOutIcon,
  ZoomInIcon,
  ContrastIcon,
} from './Icons.jsx';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { getSetting, setSetting } from '../utils/settings.js';
import 'pdfjs-dist/web/pdf_viewer.css';
import { getErrorHelp } from '../utils/latexErrorHelp.js';
import parseLog from '../utils/latexLogParser.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const DEFAULT_SCALE = 1.5;
const ZOOM_STEP = 0.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const OBSERVER_MARGIN = 1500; // px buffer for pre-rendering pages near viewport
const DESTROY_PAGES_BEYOND = 5; // destroy canvases beyond this many pages from viewport

/** Scrollable panel displaying raw LaTeX compiler output. */
function ConsolePanel({ output, compiling }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [output]);

  return (
    <div className="pdf-console-panel" ref={ref}>
      {output ? (
        <pre className="pdf-console-output">{output}</pre>
      ) : (
        <div className="pdf-console-empty">
          {compiling ? 'Starting compilation...' : 'No output yet. Click "PDF" to compile.'}
        </div>
      )}
      {compiling && <div className="pdf-console-spinner">&#9679; Running...</div>}
    </div>
  );
}

/** Single error or warning row in the log panel, with optional help button. */
function LogItem({ className, onClick, tag, file, line, message, help, onShowHelp }) {
  return (
    <div className={className}>
      <div className="pdf-log-item-row" onClick={onClick}>
        {tag && <span className="pdf-log-tag">{tag}</span>}
        {file && <span className="pdf-log-file">{file}</span>}
        {line && <span className="pdf-log-line">line {line}</span>}
        <span className="pdf-log-message">{message}</span>
        {help && (
          <button
            className="pdf-log-help-btn"
            onClick={(e) => {
              e.stopPropagation();
              onShowHelp?.({ ...help, message });
            }}
            title="How to fix this"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/** Detailed help view for a specific LaTeX error, with suggestions and external search links. */
function HelpPanel({ help, onBack }) {
  return (
    <div className="pdf-help-panel">
      <div className="pdf-help-header">
        <button className="pdf-help-back" onClick={onBack}>
          <ChevronLeftIcon />
          Back
        </button>
      </div>
      <div className="pdf-help-content">
        <div className="pdf-help-title">{help.title}</div>
        <div className="pdf-help-message">{help.message}</div>
        <div className="pdf-help-suggestion">{help.suggestion}</div>

        {help.tips.length > 0 && (
          <div className="pdf-help-section">
            <div className="pdf-help-section-title">Suggestions</div>
            <ul className="pdf-help-tips">
              {help.tips.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          </div>
        )}

        {help.example && (
          <div className="pdf-help-section">
            <div className="pdf-help-section-title">Example</div>
            <pre className="pdf-help-example">{help.example}</pre>
          </div>
        )}

        <div className="pdf-help-links">
          <a href={help.searchUrl} target="_blank" rel="noopener noreferrer" className="pdf-help-link">
            <SearchIcon />
            Search TeX Stack Exchange
          </a>
          <a
            href={`https://www.google.com/search?q=${encodeURIComponent(help.message + ' latex')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="pdf-help-link"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="18 13 18 6 11 6" />
              <line x1="18" y1="6" x2="9" y2="15" />
              <path d="M5 19H3v-2" />
              <path d="M3 13v-2" />
              <path d="M3 7V5h2" />
              <path d="M9 5h2" />
              <path d="M15 19h-2" />
              <path d="M9 19H7" />
            </svg>
            Search Google
          </a>
        </div>
      </div>
    </div>
  );
}

/** PDF viewer with zoom, page navigation, pinch-to-zoom, SyncTeX click, and virtualized page rendering. */
const PdfViewer = forwardRef(function PdfViewer(
  {
    url,
    compiling,
    onCompile,
    onStopCompile,
    onCleanFiles,
    onCleanCompile,
    onPdfClick,
    onPdfPositionChange,
    compileLog,
    consoleOutput,
    lintDiagnostics,
    style,
    onGoToLine,
    onGoToFileAndLine,
    tapsDiagnostics,
    showBoxWarnings = true,
    onToggleBoxWarnings,
    onOpenSettings,
    mainFileExists = true,
    mainFileChanged = false,
    showTrackedChangesInPdf = false,
    onToggleTrackedChangesInPdf,
  },
  ref,
) {
  const containerRef = useRef(null);
  const [error, setError] = useState(null);
  const pageInfoRef = useRef([]);
  const pdfDocRef = useRef(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [fitMode, setFitMode] = useState(null); // 'width' | 'page' | null
  const visualScaleRef = useRef(DEFAULT_SCALE); // tracks live pinch scale for CSS transform
  const commitTimerRef = useRef(null);
  const baseScaleOnPinchRef = useRef(DEFAULT_SCALE); // the committed scale when pinch started
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [showPanel, setShowPanel] = useState(null); // 'errors' | 'warnings' | 'lint' | null
  const [inverted, setInverted] = useState(() => getSetting('pdf-inverted') === 'true');
  useEffect(() => {
    const handler = (e) => {
      if (e.detail.pdfInverted !== undefined) setInverted(e.detail.pdfInverted);
    };
    window.addEventListener('flowtex:settings-changed', handler);
    return () => window.removeEventListener('flowtex:settings-changed', handler);
  }, []);
  const [helpDetail, setHelpDetail] = useState(null); // when set, shows the help panel
  const prevUrlRef = useRef(null);
  const [showCompileMenu, setShowCompileMenu] = useState(false);
  const compileMenuRef = useRef(null);

  // Virtualization refs
  const pageProxyRef = useRef([]); // per-page data: { pdfPage, viewport, pageScale, wrapper, canvas, textLayerDiv }
  const renderedPagesRef = useRef(new Set()); // indices of pages with active canvases
  const renderingPagesRef = useRef(new Set()); // indices of pages currently being rendered (to avoid duplicates)
  const observerRef = useRef(null);
  const renderPageRef = useRef(null); // stable ref to renderPageCanvas for use in scrollToPosition

  const { errors, warnings: allWarnings } = useMemo(() => parseLog(compileLog), [compileLog]);
  const warnings = useMemo(() => {
    if (showBoxWarnings) return allWarnings;
    return allWarnings.filter((w) => !/^(Overfull|Underfull)\s+\\[hv]box/.test(w.text));
  }, [allWarnings, showBoxWarnings]);
  const hiddenBoxCount = allWarnings.length - warnings.length;
  const lintErrors = useMemo(() => (lintDiagnostics || []).filter((d) => d.severity === 'error'), [lintDiagnostics]);
  const lintWarnings = useMemo(
    () => (lintDiagnostics || []).filter((d) => d.severity === 'warning'),
    [lintDiagnostics],
  );

  useImperativeHandle(ref, () => ({
    scrollToPosition(page, yPt) {
      const info = pageInfoRef.current[page - 1];
      if (!info || !containerRef.current) return;
      // Eagerly render the target page so it's visible immediately after scroll
      renderPageRef.current?.(page - 1);
      const container = containerRef.current;
      const pageHeightPt = info.viewport.viewBox[3];
      const yFromTop = pageHeightPt - yPt;
      const yPx = yFromTop * scale;
      const wrapperTop = info.wrapper.offsetTop;
      container.scrollTo({
        top: wrapperTop + yPx - container.clientHeight / 3,
        behavior: 'smooth',
      });
    },
  }));

  const handlePageClick = useCallback(
    (pageNum, viewport, e) => {
      const wrapper = e.currentTarget;
      const rect = wrapper.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const xPt = clickX / scale;
      const yPt = clickY / scale;
      // Always report position for the sync arrow
      onPdfPositionChange?.({ page: pageNum, x: xPt, y: yPt });
      if (onPdfClick) {
        onPdfClick(pageNum, xPt, yPt);
      }
    },
    [onPdfClick, onPdfPositionChange, scale],
  );

  // Load PDF document when URL changes
  useEffect(() => {
    pdfDocRef.current = null;
    if (!url) return;
    let cancelled = false;
    pdfjsLib
      .getDocument(url)
      .promise.then((pdf) => {
        if (!cancelled) pdfDocRef.current = pdf;
      })
      .catch(() => {
        if (!cancelled) pdfDocRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Render pages with virtualization: create all placeholder wrappers, but only
  // render canvases for pages near the viewport. IntersectionObserver triggers
  // on-demand rendering; far-off-screen canvases are destroyed on scroll.

  useEffect(() => {
    if (!url || !containerRef.current) return;

    let cancelled = false;
    setError(null);
    const container = containerRef.current;
    // Capture refs for cleanup (their .current may differ at unmount time)
    const renderedPages = renderedPagesRef.current;
    const renderingPages = renderingPagesRef.current;

    // Capture scroll position relative to current page before re-render
    let savedPage = 1;
    let savedFraction = 0;
    if (pageInfoRef.current.length > 0) {
      const scrollTop = container.scrollTop;
      for (let i = 0; i < pageInfoRef.current.length; i++) {
        const info = pageInfoRef.current[i];
        const top = info.wrapper.offsetTop;
        const height = info.wrapper.offsetHeight;
        if (scrollTop < top + height) {
          savedPage = i + 1;
          savedFraction = Math.max(0, (scrollTop - top) / height);
          break;
        }
      }
    }
    prevUrlRef.current = url;

    // Clean up previous state
    observerRef.current?.disconnect();
    observerRef.current = null;
    renderedPagesRef.current.clear();
    renderingPagesRef.current.clear();
    container.replaceChildren();
    pageInfoRef.current = [];
    pageProxyRef.current = [];
    visualScaleRef.current = scale;
    baseScaleOnPinchRef.current = scale;

    const dpr = window.devicePixelRatio || 1;

    // Render a single page's canvas and text layer on demand
    async function renderPageCanvas(idx) {
      if (cancelled) return;
      if (renderedPagesRef.current.has(idx)) return;
      if (renderingPagesRef.current.has(idx)) return;
      renderingPagesRef.current.add(idx);

      try {
        const proxy = pageProxyRef.current[idx];
        if (!proxy) return;

        const { pdfPage, viewport, pageScale, wrapper } = proxy;
        const pxWidth = Math.floor(viewport.width);
        const pxHeight = Math.floor(viewport.height);

        // Create canvas
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page';
        canvas.width = Math.floor(pxWidth * dpr);
        canvas.height = Math.floor(pxHeight * dpr);
        canvas.style.width = `${pxWidth}px`;
        canvas.style.height = `${pxHeight}px`;
        wrapper.appendChild(canvas);

        // Create text layer
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.position = 'absolute';
        textLayerDiv.style.left = '0';
        textLayerDiv.style.top = '0';
        textLayerDiv.style.width = `${pxWidth}px`;
        textLayerDiv.style.height = `${pxHeight}px`;
        wrapper.appendChild(textLayerDiv);

        proxy.canvas = canvas;
        proxy.textLayerDiv = textLayerDiv;

        // Render canvas
        const ctx = canvas.getContext('2d');
        const renderViewport = pdfPage.getViewport({ scale: pageScale * dpr });
        await pdfPage.render({ canvasContext: ctx, viewport: renderViewport }).promise;
        if (cancelled) return;

        // Render text layer
        const textContent = await pdfPage.getTextContent();
        if (cancelled) return;
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport: viewport,
        });
        await textLayer.render();

        renderedPagesRef.current.add(idx);
      } catch (err) {
        if (!cancelled) console.warn('Page render error:', err);
      } finally {
        renderingPagesRef.current.delete(idx);
      }
    }

    // Store in ref so scrollToPosition can call it
    renderPageRef.current = renderPageCanvas;

    const layoutPages = async () => {
      try {
        let pdf = pdfDocRef.current;
        if (!pdf) pdf = await pdfjsLib.getDocument(url).promise;
        if (cancelled) return;
        pdfDocRef.current = pdf;
        setNumPages(pdf.numPages);

        // Get reference width from first page for consistent scaling
        const firstPage = await pdf.getPage(1);
        if (cancelled) return;
        const refWidth = firstPage.getViewport({ scale: 1 }).width;

        // Phase 1: Create all placeholder wrappers (no canvases yet)
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = i === 1 ? firstPage : await pdf.getPage(i);
          if (cancelled) return;
          const nativeWidth = page.getViewport({ scale: 1 }).width;
          const pageScale = scale * (refWidth / nativeWidth);
          const viewport = page.getViewport({ scale: pageScale });

          const pxWidth = Math.floor(viewport.width);
          const pxHeight = Math.floor(viewport.height);

          const wrapper = document.createElement('div');
          wrapper.className = 'pdf-page-wrapper';
          wrapper.style.position = 'relative';
          wrapper.style.width = `${pxWidth}px`;
          wrapper.style.height = `${pxHeight}px`;
          wrapper.dataset.pageIndex = String(i - 1);

          const vp = viewport;
          wrapper.addEventListener('dblclick', (e) => {
            window.getSelection()?.removeAllRanges();
            handlePageClick(i, vp, e);
          });
          container.appendChild(wrapper);

          pageInfoRef.current.push({ wrapper, viewport, pageNum: i });
          pageProxyRef.current.push({ pdfPage: page, viewport, pageScale, wrapper, canvas: null, textLayerDiv: null });
        }

        // Restore scroll position now that all wrappers are in the DOM
        if (pageInfoRef.current.length >= savedPage && savedPage > 0) {
          const info = pageInfoRef.current[savedPage - 1];
          container.scrollTop = info.wrapper.offsetTop + savedFraction * info.wrapper.offsetHeight;
          setCurrentPage(savedPage);
        }

        // Phase 2: Set up IntersectionObserver to render visible pages on demand
        if (cancelled) return;
        observerRef.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                const idx = Number(entry.target.dataset.pageIndex);
                renderPageCanvas(idx);
              }
            }
          },
          {
            root: container,
            rootMargin: `${OBSERVER_MARGIN}px 0px ${OBSERVER_MARGIN}px 0px`,
          },
        );

        for (const proxy of pageProxyRef.current) {
          observerRef.current.observe(proxy.wrapper);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('PDF load error:', err);
          setError('Failed to load PDF');
        }
      }
    };

    layoutPages();

    return () => {
      cancelled = true;
      observerRef.current?.disconnect();
      observerRef.current = null;
      renderedPages.clear();
      renderingPages.clear();
      pageProxyRef.current = [];
      renderPageRef.current = null;
    };
  }, [url, scale, handlePageClick]);

  // Track current page from scroll position + clean up far-off-screen canvases
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const pages = pageInfoRef.current;
      if (!pages.length) return;
      const scrollTop = container.scrollTop + container.clientHeight / 3;
      for (let i = pages.length - 1; i >= 0; i--) {
        if (pages[i].wrapper.offsetTop <= scrollTop) {
          setCurrentPage(i + 1);
          break;
        }
        if (i === 0) setCurrentPage(1);
      }

      // Destroy canvases for pages far from the viewport to free memory
      const visibleTop = container.scrollTop;
      const visibleBottom = visibleTop + container.clientHeight;
      const toDestroy = [];
      for (const idx of renderedPagesRef.current) {
        const proxy = pageProxyRef.current[idx];
        if (!proxy) continue;
        const top = proxy.wrapper.offsetTop;
        const bottom = top + proxy.wrapper.offsetHeight;
        const bufferPx = DESTROY_PAGES_BEYOND * proxy.wrapper.offsetHeight;
        if (bottom < visibleTop - bufferPx || top > visibleBottom + bufferPx) {
          toDestroy.push(idx);
        }
      }
      for (const idx of toDestroy) {
        const proxy = pageProxyRef.current[idx];
        if (proxy?.canvas) {
          proxy.canvas.width = 0;
          proxy.canvas.remove();
          proxy.canvas = null;
        }
        if (proxy?.textLayerDiv) {
          proxy.textLayerDiv.remove();
          proxy.textLayerDiv = null;
        }
        renderedPagesRef.current.delete(idx);
      }
    };
    container.addEventListener('scroll', handleScroll);

    // Pinch-to-zoom on trackpad (fires as wheel + ctrlKey on Mac)
    // Uses CSS transform for instant visual feedback, then commits the final scale after a pause
    const handleWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.01;
      const newVisual = Math.min(MAX_SCALE, Math.max(MIN_SCALE, visualScaleRef.current + delta));
      visualScaleRef.current = newVisual;

      // Apply CSS transform for instant feedback (relative to the committed render scale)
      const cssScale = newVisual / baseScaleOnPinchRef.current;
      container.style.transformOrigin = 'top center';
      container.style.transform = `scale(${cssScale})`;

      // Debounce: commit the actual scale after pinch gesture settles
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(() => {
        container.style.transform = '';
        container.style.transformOrigin = '';
        baseScaleOnPinchRef.current = newVisual;
        setFitMode(null);
        setScale(newVisual);
      }, 200);
    };
    container.addEventListener('wheel', handleWheel, { passive: false });

    // Prevent Safari's native gesture zoom
    const preventGesture = (e) => e.preventDefault();
    container.addEventListener('gesturestart', preventGesture, { passive: false });
    container.addEventListener('gesturechange', preventGesture, { passive: false });
    container.addEventListener('gestureend', preventGesture, { passive: false });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('gesturestart', preventGesture);
      container.removeEventListener('gesturechange', preventGesture);
      container.removeEventListener('gestureend', preventGesture);
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, [url, scale]);

  const goToPrevPage = () => {
    const target = Math.max(1, currentPage - 1);
    const info = pageInfoRef.current[target - 1];
    if (info && containerRef.current) {
      containerRef.current.scrollTo({ top: info.wrapper.offsetTop, behavior: 'smooth' });
    }
  };

  const goToNextPage = () => {
    const target = Math.min(numPages, currentPage + 1);
    const info = pageInfoRef.current[target - 1];
    if (info && containerRef.current) {
      containerRef.current.scrollTo({ top: info.wrapper.offsetTop, behavior: 'smooth' });
    }
  };

  /** Commit a new zoom scale, updating both the visual ref and triggering a re-render. */
  const commitScale = useCallback((newScale) => {
    const s = typeof newScale === 'function' ? newScale(visualScaleRef.current) : newScale;
    visualScaleRef.current = s;
    baseScaleOnPinchRef.current = s;
    setScale(s);
  }, []);
  const zoomIn = () => { setFitMode(null); commitScale((s) => Math.min(s + ZOOM_STEP, MAX_SCALE)); };
  const zoomOut = () => { setFitMode(null); commitScale((s) => Math.max(s - ZOOM_STEP, MIN_SCALE)); };

  /** Adjust zoom so the PDF page width fills the container. */
  const fitWidth = () => {
    if (!containerRef.current || !pdfDocRef.current) return;
    setFitMode('width');
    pdfDocRef.current.getPage(1).then((page) => {
      const vp = page.getViewport({ scale: 1 });
      const containerWidth = containerRef.current.clientWidth - 32; // subtract padding
      commitScale(containerWidth / vp.width);
    });
  };

  /** Adjust zoom so an entire PDF page fits within the container. */
  const fitPage = () => {
    if (!containerRef.current || !pdfDocRef.current) return;
    setFitMode('page');
    pdfDocRef.current.getPage(1).then((page) => {
      const vp = page.getViewport({ scale: 1 });
      const containerWidth = containerRef.current.clientWidth - 32;
      const containerHeight = containerRef.current.clientHeight - 32;
      const scaleW = containerWidth / vp.width;
      const scaleH = containerHeight / vp.height;
      commitScale(Math.min(scaleW, scaleH));
    });
  };

  const togglePanel = (panel) => {
    setShowPanel((cur) => (cur === panel ? null : panel));
  };

  useClickOutside(
    compileMenuRef,
    useCallback(() => setShowCompileMenu(false), []),
    showCompileMenu,
  );

  return (
    <div className="pdf-viewer" style={style}>
      <div className="pdf-viewer-header">
        <div className="compile-btn-group" ref={compileMenuRef}>
          <button className="pdf-compile-btn" onClick={onCompile} disabled={compiling}>
            {compiling ? (
              <>
                <svg
                  className="compile-spinner"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
                Compiling...
              </>
            ) : (
              'PDF'
            )}
          </button>
          <button className="compile-menu-toggle" onClick={() => setShowCompileMenu(!showCompileMenu)}>
            <DropdownCaretIcon />
          </button>
          {showCompileMenu && (
            <div className="compile-dropdown-menu">
              <button
                disabled={compiling}
                onClick={() => {
                  setShowCompileMenu(false);
                  onCompile?.();
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                PDF
              </button>
              <button
                disabled={compiling}
                onClick={() => {
                  setShowCompileMenu(false);
                  onCleanCompile?.();
                }}
              >
                <RedoIcon />
                PDF from scratch
              </button>
              <div className="compile-dropdown-separator" />
              <button
                disabled={compiling}
                onClick={() => {
                  setShowCompileMenu(false);
                  onCleanFiles?.();
                }}
              >
                <TrashIcon />
                Clear generated files
              </button>
            </div>
          )}
        </div>
        {compiling && (
          <button className="pdf-stop-btn" onClick={onStopCompile} title="Stop compilation">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <rect x="2" y="2" width="12" height="12" rx="1" />
            </svg>
          </button>
        )}
        <button
          className={`pdf-header-btn ${errors.length + lintErrors.length > 0 ? 'has-errors' : ''} ${showPanel === 'errors' ? 'active' : ''}`}
          onClick={() => togglePanel('errors')}
        >
          {errors.length + lintErrors.length} error{errors.length + lintErrors.length !== 1 ? 's' : ''}
        </button>
        <button
          className={`pdf-header-btn ${warnings.length + lintWarnings.length + (tapsDiagnostics?.length || 0) > 0 ? 'has-warnings' : ''} ${showPanel === 'warnings' ? 'active' : ''}`}
          onClick={() => togglePanel('warnings')}
        >
          {warnings.length + lintWarnings.length + (tapsDiagnostics?.length || 0)} warning
          {warnings.length + lintWarnings.length + (tapsDiagnostics?.length || 0) !== 1 ? 's' : ''}
        </button>
        {onToggleBoxWarnings && (
          <button
            className={`pdf-zoom-btn ${showBoxWarnings ? 'active' : ''}`}
            onClick={onToggleBoxWarnings}
            title={showBoxWarnings ? 'Hide overfull/underfull box warnings' : 'Show overfull/underfull box warnings'}
            style={{ marginLeft: 2 }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="5" width="14" height="14" rx="1" />
              <line x1="17" y1="10" x2="22" y2="10" />
              <polyline points="20,8 22,10 20,12" />
            </svg>
          </button>
        )}
        <button
          className={`pdf-header-btn console-btn ${showPanel === 'console' ? 'active' : ''} ${consoleOutput ? 'has-console' : ''}`}
          onClick={() => togglePanel('console')}
        >
          Console
          {consoleOutput && showPanel !== 'console' && <span className="console-badge" />}
        </button>
        {onToggleTrackedChangesInPdf && (
          <button
            className={`pdf-zoom-btn pdf-tc-btn ${showTrackedChangesInPdf ? 'active' : ''}`}
            onClick={onToggleTrackedChangesInPdf}
            title={showTrackedChangesInPdf ? 'Hide tracked changes in PDF' : 'Show tracked changes in PDF'}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              {showTrackedChangesInPdf && (
                <>
                  <line x1="1" y1="1" x2="5" y2="5" stroke="red" strokeWidth="1.5" />
                  <line x1="1" y1="5" x2="5" y2="1" stroke="red" strokeWidth="1.5" />
                  <line x1="1" y1="9" x2="6" y2="9" stroke="blue" strokeWidth="1.5" />
                </>
              )}
            </svg>
          </button>
        )}
        {url && (
          <a className="pdf-header-btn pdf-download-btn" href={url} download="output.pdf" title="Download PDF">
            <DownloadIcon />
          </a>
        )}
        {numPages > 0 && (
          <div className="pdf-page-nav">
            <button className="pdf-zoom-btn" onClick={goToPrevPage} title="Previous page" disabled={currentPage <= 1}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </button>
            <span className="pdf-page-indicator">
              {currentPage} / {numPages}
            </span>
            <button
              className="pdf-zoom-btn"
              onClick={goToNextPage}
              title="Next page"
              disabled={currentPage >= numPages}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        )}
        <div className="pdf-zoom-controls">
          <button className="pdf-zoom-btn" onClick={zoomOut} title="Zoom out" disabled={scale <= MIN_SCALE}>
            <ZoomOutIcon />
          </button>
          <span className="pdf-zoom-level">{Math.round(scale * 100)}%</span>
          <button className="pdf-zoom-btn" onClick={zoomIn} title="Zoom in" disabled={scale >= MAX_SCALE}>
            <ZoomInIcon />
          </button>
          <button className={`pdf-zoom-btn ${fitMode === 'width' ? 'active' : ''}`} onClick={fitWidth} title="Fit width">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="12" x2="21" y2="12" />
              <polyline points="3,8 3,12 3,16" />
              <polyline points="21,8 21,12 21,16" />
            </svg>
          </button>
          <button className={`pdf-zoom-btn ${fitMode === 'page' ? 'active' : ''}`} onClick={fitPage} title="Fit page">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          </button>
          <button
            className={`pdf-zoom-btn ${inverted ? 'active' : ''}`}
            onClick={() =>
              setInverted((v) => {
                const n = !v;
                setSetting('pdf-inverted', n);
                return n;
              })
            }
            title="Invert colors"
          >
            <ContrastIcon />
          </button>
        </div>
      </div>
      {helpDetail && (showPanel === 'errors' || showPanel === 'warnings') && (
        <HelpPanel help={helpDetail} onBack={() => setHelpDetail(null)} />
      )}
      {!helpDetail && showPanel === 'errors' && errors.length + lintErrors.length > 0 && (
        <div className="pdf-log-panel errors">
          {lintErrors.map((e, i) => (
            <LogItem
              key={`lint-${i}`}
              className="pdf-log-item error clickable"
              onClick={() => onGoToLine?.(e.line, e.col)}
              tag="lint"
              line={e.line}
              message={e.message}
              help={getErrorHelp(e.message)}
              onShowHelp={setHelpDetail}
            />
          ))}
          {errors
            .filter((e) => !e.isSystemFile)
            .map((e, i) => (
              <LogItem
                key={`compile-${i}`}
                className={`pdf-log-item error ${e.line ? 'clickable' : ''}`}
                onClick={() =>
                  e.line && (e.file ? onGoToFileAndLine?.(e.file, e.line, e.col) : onGoToLine?.(e.line, e.col))
                }
                file={e.file}
                line={e.line}
                message={e.text}
                help={getErrorHelp(e.text)}
                onShowHelp={setHelpDetail}
              />
            ))}
          {errors
            .filter((e) => e.isSystemFile)
            .map((e, i) => (
              <LogItem
                key={`system-${i}`}
                className="pdf-log-item system-error"
                file={e.file}
                line={e.line}
                message={e.text}
                tag="package"
              />
            ))}
        </div>
      )}
      {!helpDetail &&
        showPanel === 'warnings' &&
        warnings.length + lintWarnings.length + (tapsDiagnostics?.length || 0) + hiddenBoxCount > 0 && (
          <div className="pdf-log-panel warnings">
            {hiddenBoxCount > 0 && (
              <div className="pdf-log-hidden-notice clickable" onClick={() => onOpenSettings?.('compiler')}>
                {hiddenBoxCount} overfull/underfull box warning{hiddenBoxCount !== 1 ? 's' : ''} hidden — click to open
                settings
              </div>
            )}
            {(tapsDiagnostics || []).map((w, i) => (
              <LogItem
                key={`taps-${i}`}
                className="pdf-log-item warning taps clickable"
                onClick={() => onGoToFileAndLine?.(w.file, w.line)}
                tag={
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" style={{ marginRight: 3, verticalAlign: -1 }}>
                      <polygon points="12,1 23,12 12,23 1,12" fill="#2065AC" />
                    </svg>
                    TAPS
                  </>
                }
                file={w.file}
                line={w.line}
                message={w.message}
              />
            ))}
            {lintWarnings.map((w, i) => (
              <LogItem
                key={`lint-${i}`}
                className="pdf-log-item warning clickable"
                onClick={() => onGoToLine?.(w.line, w.col)}
                tag="lint"
                line={w.line}
                message={w.message}
                help={getErrorHelp(w.message)}
                onShowHelp={setHelpDetail}
              />
            ))}
            {warnings
              .filter((w) => !w.isSystemFile)
              .map((w, i) => (
                <LogItem
                  key={`compile-${i}`}
                  className={`pdf-log-item warning ${w.line ? 'clickable' : ''}`}
                  onClick={() => w.line && (w.file ? onGoToFileAndLine?.(w.file, w.line) : onGoToLine?.(w.line))}
                  file={w.file}
                  line={w.line}
                  message={w.text}
                  help={getErrorHelp(w.text)}
                  onShowHelp={setHelpDetail}
                />
              ))}
            {warnings
              .filter((w) => w.isSystemFile)
              .map((w, i) => (
                <LogItem
                  key={`system-${i}`}
                  className="pdf-log-item system-error"
                  file={w.file}
                  line={w.line}
                  message={w.text}
                  tag="package"
                />
              ))}
          </div>
        )}
      {!helpDetail && showPanel === 'errors' && errors.length === 0 && lintErrors.length === 0 && (
        <div className="pdf-log-panel empty">No errors</div>
      )}
      {!helpDetail &&
        showPanel === 'warnings' &&
        warnings.length === 0 &&
        lintWarnings.length === 0 &&
        (tapsDiagnostics?.length || 0) === 0 &&
        hiddenBoxCount === 0 && <div className="pdf-log-panel empty">No warnings</div>}
      {showPanel === 'console' && <ConsolePanel output={consoleOutput} compiling={compiling} />}
      {!mainFileExists && !url && !compiling && (
        <div className="pdf-no-main-file-banner">
          No main file found. Right-click a <code>.tex</code> file in the file tree and select &quot;Set as Main File&quot; to
          compile your project.
        </div>
      )}
      {mainFileChanged && !compiling && (
        <div className="pdf-recompile-banner">Main file changed. Click &quot;PDF&quot; to recompile with the new main file.</div>
      )}
      {!url && !compiling && mainFileExists && !mainFileChanged && (
        <div className="pdf-placeholder">Click &quot;PDF&quot; to generate PDF</div>
      )}
      {error && <div className="pdf-error">{error}</div>}
      <div className={`pdf-container ${inverted ? 'pdf-inverted' : ''}`} ref={containerRef} />
    </div>
  );
});

export default PdfViewer;
