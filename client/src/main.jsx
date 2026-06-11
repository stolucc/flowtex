// @ts-check
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
// @ts-ignore -- vite-handled CSS import
import './styles/app.css';

// Prevent browser-level pinch-to-zoom (Ctrl+wheel on macOS trackpad)
// so it doesn't interfere with our custom PDF zoom handler.
// Must be at the document level to catch it before the browser acts.
document.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false },
);

// Recover from stale chunk-hash errors after a deploy. Vite content-hashes
// every chunk filename — when a new build replaces the old chunks but the
// browser still has the previous index.html cached, lazy `import()` calls
// 404 with "Failed to fetch dynamically imported module". Vite emits a
// `vite:preloadError` event in that exact case; reloading the page
// fetches the fresh index.html (and its new chunk hashes) and the user
// is back in business. We only auto-reload once per session to avoid an
// infinite loop if the chunk is genuinely missing for some other reason.
window.addEventListener('vite:preloadError', () => {
  if (!sessionStorage.getItem('flowtex-reloaded-after-preload-error')) {
    sessionStorage.setItem('flowtex-reloaded-after-preload-error', '1');
    window.location.reload();
  }
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing from index.html');
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
