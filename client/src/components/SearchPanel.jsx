import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Decoration } from '@codemirror/view';

function SearchPanel({ view, onClose, projectFiles, onGoToFile, setSearchHighlightEffect }) {
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [matchCount, setMatchCount] = useState(0);
  const [scope, setScope] = useState('file'); // 'file' | 'tex' | 'all'
  const [globalResults, setGlobalResults] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Local file search
  const findMatches = useCallback((q, cs) => {
    if (!view || !q) return [];
    const doc = view.state.doc.toString();
    const matches = [];
    const searchStr = cs ? q : q.toLowerCase();
    const haystack = cs ? doc : doc.toLowerCase();
    let pos = 0;
    while (pos < haystack.length) {
      const idx = haystack.indexOf(searchStr, pos);
      if (idx === -1) break;
      matches.push({ from: idx, to: idx + q.length });
      pos = idx + 1;
    }
    return matches;
  }, [view]);

  const updateHighlights = useCallback((q, cs, currentIdx) => {
    if (!view) return;
    if (scope !== 'file') {
      view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
      return;
    }
    const matches = findMatches(q, cs);
    setMatchCount(matches.length);
    if (matches.length === 0) {
      view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
      setMatchIndex(-1);
      return;
    }
    const decos = matches.map((m, i) =>
      Decoration.mark({
        class: i === currentIdx ? 'cm-search-match-current' : 'cm-search-match',
      }).range(m.from, m.to)
    );
    view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.set(decos)) });
  }, [view, findMatches, scope, setSearchHighlightEffect]);

  // Global search — runs client-side against in-memory file contents
  useEffect(() => {
    if (scope === 'file') { setGlobalResults([]); return; }
    const q = query.trim();
    if (!q || !projectFiles?.length) { setGlobalResults([]); return; }
    const searchStr = caseSensitive ? q : q.toLowerCase();
    const results = [];
    for (const file of projectFiles) {
      if (scope === 'tex' && !file.path.endsWith('.tex')) continue;
      if (!file.content) continue;
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const haystack = caseSensitive ? line : line.toLowerCase();
        let pos = 0;
        while (pos < haystack.length) {
          const idx = haystack.indexOf(searchStr, pos);
          if (idx === -1) break;
          results.push({ fileId: file.id, filePath: file.path, line: i + 1, col: idx, text: line.trim() });
          pos = idx + 1;
          if (results.length >= 500) break;
        }
        if (results.length >= 500) break;
      }
      if (results.length >= 500) break;
    }
    setGlobalResults(results);
  }, [query, scope, caseSensitive, projectFiles]);

  // Local highlights
  useEffect(() => {
    if (scope === 'file') {
      updateHighlights(query, caseSensitive, -1);
      setMatchIndex(-1);
    }
    return () => {
      if (view) view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
    };
  }, [query, caseSensitive, scope]);

  const goToMatch = useCallback((dir) => {
    const matches = findMatches(query, caseSensitive);
    if (matches.length === 0) return;
    let idx;
    if (dir === 'next') {
      const cursor = view.state.selection.main.from;
      idx = matches.findIndex((m) => m.from > cursor);
      if (idx === -1) idx = 0;
    } else {
      const cursor = view.state.selection.main.from;
      for (idx = matches.length - 1; idx >= 0; idx--) {
        if (matches[idx].from < cursor) break;
      }
      if (idx < 0) idx = matches.length - 1;
    }
    setMatchIndex(idx);
    updateHighlights(query, caseSensitive, idx);
    const m = matches[idx];
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
    });
    view.focus();
  }, [view, query, caseSensitive, findMatches, updateHighlights]);

  const handleReplace = useCallback(() => {
    const matches = findMatches(query, caseSensitive);
    if (matchIndex < 0 || matchIndex >= matches.length) return;
    const m = matches[matchIndex];
    view.dispatch({ changes: { from: m.from, to: m.to, insert: replace } });
    setTimeout(() => goToMatch('next'), 0);
  }, [view, query, replace, caseSensitive, matchIndex, findMatches, goToMatch]);

  const handleReplaceAll = useCallback(() => {
    const matches = findMatches(query, caseSensitive);
    if (matches.length === 0) return;
    const changes = [...matches].reverse().map((m) => ({
      from: m.from, to: m.to, insert: replace,
    }));
    view.dispatch({ changes });
    setMatchIndex(-1);
    setMatchCount(0);
    view.dispatch({ effects: setSearchHighlightEffect.of(Decoration.none) });
  }, [view, query, replace, caseSensitive, findMatches, setSearchHighlightEffect]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (scope === 'file') {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goToMatch('next'); }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goToMatch('prev'); }
    }
  };

  const highlightMatch = (text, q, cs) => {
    if (!q) return text;
    const searchStr = cs ? q : q.toLowerCase();
    const haystack = cs ? text : text.toLowerCase();
    const idx = haystack.indexOf(searchStr);
    if (idx === -1) return text;
    return (
      <>{text.slice(0, idx)}<mark className="search-result-highlight">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>
    );
  };

  const isGlobal = scope !== 'file';

  return (
    <div className="editor-search-panel">
      <div className="editor-search-toolbar">
        <div className="editor-search-scope">
          <button className={`editor-search-scope-btn ${scope === 'file' ? 'active' : ''}`} onClick={() => setScope('file')}>Current File</button>
          <button className={`editor-search-scope-btn ${scope === 'tex' ? 'active' : ''}`} onClick={() => setScope('tex')}>.tex Files</button>
          <button className={`editor-search-scope-btn ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>All Files</button>
        </div>
        <button className="editor-search-close" onClick={onClose} title="Close (Esc)">&times;</button>
      </div>
      <div className="editor-search-row">
        <input
          ref={inputRef}
          className="editor-search-input"
          placeholder={isGlobal ? 'Search in project...' : 'Find...'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {!isGlobal && (
          <span className="editor-search-count">
            {query ? (matchCount > 0 ? `${matchIndex >= 0 ? matchIndex + 1 : '–'}/${matchCount}` : 'No results') : ''}
          </span>
        )}
        {isGlobal && (
          <span className="editor-search-count">
            {query ? `${globalResults.length}${globalResults.length >= 500 ? '+' : ''} results` : ''}
          </span>
        )}
        {!isGlobal && (
          <>
            <button className="editor-search-btn" onClick={() => goToMatch('prev')} title="Previous (Shift+Enter)">&#x25B2;</button>
            <button className="editor-search-btn" onClick={() => goToMatch('next')} title="Next (Enter)">&#x25BC;</button>
          </>
        )}
        <button
          className={`editor-search-btn ${caseSensitive ? 'active' : ''}`}
          onClick={() => setCaseSensitive(!caseSensitive)}
          title="Case sensitive"
        >Aa</button>
        {!isGlobal && (
          <button
            className={`editor-search-btn ${showReplace ? 'active' : ''}`}
            onClick={() => setShowReplace(!showReplace)}
            title="Replace"
          >⇄</button>
        )}
      </div>
      {!isGlobal && showReplace && (
        <div className="editor-search-row">
          <input
            className="editor-search-input"
            placeholder="Replace..."
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          />
          <button className="editor-search-btn" onClick={handleReplace} disabled={matchIndex < 0} title="Replace">Replace</button>
          <button className="editor-search-btn" onClick={handleReplaceAll} disabled={matchCount === 0} title="Replace all">All</button>
        </div>
      )}
      {isGlobal && globalResults.length > 0 && (
        <div className="editor-search-results">
          {globalResults.map((r, i) => (
            <div
              key={`${r.fileId}-${r.line}-${r.col}-${i}`}
              className="editor-search-result"
              onClick={() => onGoToFile?.(r.fileId, r.line, r.col)}
            >
              <span className="search-result-file">{r.filePath}</span>
              <span className="search-result-line">:{r.line}</span>
              <span className="search-result-text">{highlightMatch(r.text, query, caseSensitive)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchPanel;
