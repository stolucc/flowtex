// @ts-check
import React, { useState, useEffect, useRef } from 'react';
import { get, post, del } from '../api.js';
import { SearchIcon, FolderIcon, ChevronRightIcon } from './Icons.jsx';

const ITEM_TYPE_LABELS = {
  journalArticle: 'Journal Article',
  bookSection: 'Book Chapter',
  book: 'Book',
  conferencePaper: 'Conference Paper',
  thesis: 'Thesis',
  report: 'Report',
  webpage: 'Web Page',
  patent: 'Patent',
  presentation: 'Presentation',
  manuscript: 'Manuscript',
};

const EXCLUDABLE_FIELDS = [
  { key: 'abstract', label: 'Abstract' },
  { key: 'note', label: 'Note' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'file', label: 'File attachments' },
  { key: 'annote', label: 'Annotation' },
];

/** Map a Zotero item type key to a human-readable label. */
/** @param {string} type */
function itemTypeLabel(type) {
  return /** @type {Record<string, string>} */ (ITEM_TYPE_LABELS)[type] || type;
}

/**
 * Strip excluded fields (e.g. abstract, file) from a BibTeX string.
 * @param {string} bibtex - Raw BibTeX content.
 * @param {Set<string>} excludedFields - Field names to remove.
 * @returns {string} Cleaned BibTeX.
 */
/** @param {string} bibtex @param {Set<string>} excludedFields */
function filterBibtex(bibtex, excludedFields) {
  if (!excludedFields.size) return bibtex;
  // Handle multi-line field values (braces can span lines)
  let result = '';
  let depth = 0;
  let skipping = false;
  for (const line of bibtex.split('\n')) {
    if (!skipping) {
      // Check if this line starts an excluded field
      const fieldMatch = line.match(/^\s*(\w+)\s*=\s*\{/);
      if (fieldMatch && excludedFields.has(fieldMatch[1].toLowerCase())) {
        skipping = true;
        depth = 0;
        for (const ch of line) {
          if (ch === '{') depth++;
          if (ch === '}') depth--;
        }
        if (depth <= 0) skipping = false;
        continue;
      }
      result += line + '\n';
    } else {
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth <= 0) skipping = false;
    }
  }
  // Clean up trailing commas before closing brace
  result = result.replace(/,(\s*\n\s*\})/g, '$1');
  return result.trimEnd() + '\n';
}

/**
 * Extract citation keys from a BibTeX string.
 * @param {string} bibtex - Raw BibTeX content.
 * @returns {string[]} Array of citation keys.
 */
/** @param {any} bibtex */
/** @param {any} bibtex */
function extractBibKeys(bibtex) {
  const keys = [];
  const re = /@\w+\s*\{\s*([\w:.@/+-]+)/g;
  let m;
  while ((m = re.exec(bibtex)) !== null) keys.push(m[1]);
  return keys;
}

/**
 * Modal for connecting to Zotero, browsing collections, and importing references as BibTeX.
 * @param {any} props
 */
export default function ZoteroModal({ onClose, onInsert, bibFileExists, existingBibKeys, initialSearch }) {
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Library state
  const [collections, setCollections] = useState(/** @type {any[]} */ ([]));
  const [selectedCollection, setSelectedCollection] = useState(/** @type {any} */ (null));
  const [items, setItems] = useState(/** @type {any[]} */ ([]));
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState(/** @type {string} */ (initialSearch || ''));
  const [searchInput, setSearchInput] = useState(/** @type {string} */ (initialSearch || ''));
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  // Field exclusion
  const [excludedFields, setExcludedFields] = useState(new Set(['abstract', 'file']));
  const [showFieldOptions, setShowFieldOptions] = useState(false);

  const searchTimeout = useRef(/** @type {any} */ (null));

  useEffect(() => {
    get('/api/zotero/status')
      .then((/** @type {any} */ r) => r.json())
      .then((/** @type {any} */ data) => setStatus(data))
      .catch(() => setStatus({ connected: false }));
  }, []);

  useEffect(() => {
    if (!status?.connected) return;
    get('/api/zotero/collections')
      .then((/** @type {any} */ r) => r.json())
      .then((/** @type {any} */ data) => setCollections(data))
      .catch((/** @type {any} */ e) => console.warn('Failed to load Zotero collections:', e));
  }, [status?.connected]);

  useEffect(() => {
    if (!status?.connected) return;
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      start: String(page * PAGE_SIZE),
    });
    if (selectedCollection) params.set('collection', selectedCollection);
    if (search) params.set('q', search);

    get(`/api/zotero/items?${params}`)
      .then((/** @type {any} */ r) => r.json())
      .then((/** @type {any} */ data) => {
        setItems(data.items || []);
        setTotal(data.total || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [status?.connected, selectedCollection, search, page]);

  const handleConnect = async () => {
    setConnecting(true);
    setConnectError('');
    try {
      const res = await post('/api/zotero/connect', { apiKey });
      const data = await res.json();
      if (!res.ok) {
        setConnectError(data.error || `Server error (${res.status})`);
        setConnecting(false);
        return;
      }
      if (data.ok) {
        setStatus({ connected: true, zoteroUserId: data.zoteroUserId, displayName: data.displayName });
        setApiKey('');
      } else {
        setConnectError(data.error || 'Connection failed');
      }
    } catch (err) {
      console.error('Zotero connect error', err);
      setConnectError('Connection failed');
    }
    setConnecting(false);
  };

  const handleDisconnect = async () => {
    await del('/api/zotero/disconnect');
    setStatus({ connected: false });
    setCollections([]);
    setItems([]);
    setSelectedKeys(new Set());
  };

  const handleSearchInput = (/** @type {any} */ val) => {
    setSearchInput(val);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearch(val);
      setPage(0);
    }, 400);
  };

  const toggleItem = (/** @type {any} */ key) => {
    setSelectedKeys((/** @type {any} */ prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedKeys.size === items.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(items.map((/** @type {any} */ i) => i.key)));
    }
  };

  const toggleField = (/** @type {any} */ field) => {
    setExcludedFields((/** @type {any} */ prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const [duplicateWarning, setDuplicateWarning] = useState(/** @type {any} */ (null));

  const handleImport = async () => {
    if (selectedKeys.size === 0) return;
    setImporting(true);
    try {
      const res = await get(`/api/zotero/export?keys=${[...selectedKeys].join(',')}`);
      const data = await res.json();
      if (data.bibtex) {
        const filtered = filterBibtex(data.bibtex, excludedFields);
        // Check for duplicate keys
        if (existingBibKeys?.length) {
          const incoming = extractBibKeys(filtered);
          const existingSet = new Set(existingBibKeys);
          const dupes = incoming.filter((/** @type {any} */ k) => existingSet.has(k));
          if (dupes.length > 0) {
            setDuplicateWarning({ keys: dupes, bibtex: filtered });
            setImporting(false);
            return;
          }
        }
        onInsert(filtered);
        onClose();
      }
    } catch (err) {
      console.error('Zotero export failed', err);
    }
    setImporting(false);
  };

  // Build collection tree
  const rootCollections = collections.filter((/** @type {any} */ c) => !c.parentKey);
  /** @type {Record<string, any[]>} */
  const childMap = {};
  for (const c of collections) {
    if (c.parentKey) {
      if (!childMap[c.parentKey]) childMap[c.parentKey] = [];
      childMap[c.parentKey].push(c);
    }
  }

  /** Recursively render a Zotero collection and its children as sidebar entries.
   *  @param {any} col @param {number} [depth]
   */
  function renderCollection(col, depth = 0) {
    const children = childMap[col.key] || [];
    return (
      <React.Fragment key={col.key}>
        <div
          className={`zotero-collection ${selectedCollection === col.key ? 'active' : ''}`}
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => {
            setSelectedCollection(col.key === selectedCollection ? null : col.key);
            setPage(0);
          }}
        >
          <FolderIcon size={14} />
          <span className="zotero-collection-name">{col.name}</span>
          <span className="zotero-collection-count">{col.numItems}</span>
        </div>
        {children.map((/** @type {any} */ child) => renderCollection(child, depth + 1))}
      </React.Fragment>
    );
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card zotero-modal" onClick={(/** @type {any} */ e) => e.stopPropagation()}>
        <h2>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          Zotero
          {status?.connected && status.displayName && <span className="zotero-username">{status.displayName}</span>}
        </h2>

        {status === null ? (
          <div className="zotero-loading">Loading...</div>
        ) : !status.connected ? (
          <div className="zotero-connect">
            <p className="zotero-connect-info">
              Connect your Zotero account to import references into your project. You need a Zotero API key from{' '}
              <a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noopener noreferrer">
                zotero.org/settings/keys
              </a>
              .
            </p>
            <p className="zotero-connect-hint">
              Make sure to grant <strong>read access</strong> to your library.
            </p>
            <div className="zotero-connect-form">
              <input
                type="text"
                className="auth-input"
                placeholder="Zotero API Key"
                value={apiKey}
                onChange={(/** @type {any} */ e) => setApiKey(e.target.value)}
                onKeyDown={(/** @type {any} */ e) => e.key === 'Enter' && handleConnect()}
              />
              <button className="auth-button" onClick={handleConnect} disabled={connecting || !apiKey.trim()}>
                {connecting ? 'Connecting...' : 'Connect'}
              </button>
            </div>
            {connectError && <div className="zotero-error">{connectError}</div>}
            <button className="modal-close-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="zotero-browser">
            <div className="zotero-toolbar">
              <div className="zotero-search">
                <SearchIcon />
                <input
                  type="text"
                  placeholder="Search library..."
                  value={searchInput}
                  onChange={(/** @type {any} */ e) => handleSearchInput(e.target.value)}
                />
              </div>
              <button className="zotero-disconnect-btn" onClick={handleDisconnect}>
                Disconnect
              </button>
            </div>
            <div className="zotero-body">
              <div className="zotero-sidebar">
                <div
                  className={`zotero-collection ${selectedCollection === null ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedCollection(null);
                    setPage(0);
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
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  <span className="zotero-collection-name">My Library</span>
                </div>
                {rootCollections.map((/** @type {any} */ c) => renderCollection(c))}
              </div>
              <div className="zotero-items">
                {loading ? (
                  <div className="zotero-loading">Loading items...</div>
                ) : items.length === 0 ? (
                  <div className="zotero-empty">{search ? 'No matching items' : 'No items in this collection'}</div>
                ) : (
                  <>
                    <div className="zotero-items-header">
                      <label className="zotero-select-all">
                        <input
                          type="checkbox"
                          checked={selectedKeys.size === items.length && items.length > 0}
                          onChange={selectAll}
                        />
                        Select all
                      </label>
                      <span className="zotero-items-count">
                        {total} item{total !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="zotero-items-list">
                      {items.map((/** @type {any} */ item) => (
                        <div
                          key={item.key}
                          className={`zotero-item ${selectedKeys.has(item.key) ? 'selected' : ''}`}
                          onClick={() => toggleItem(item.key)}
                        >
                          <input type="checkbox" checked={selectedKeys.has(item.key)} readOnly />
                          <div className="zotero-item-info">
                            <div className="zotero-item-title">{item.title}</div>
                            <div className="zotero-item-meta">
                              <span className="zotero-item-type">{itemTypeLabel(item.type)}</span>
                              {item.creators.length > 0 && (
                                <span className="zotero-item-authors">
                                  {item.creators.slice(0, 3).join('; ')}
                                  {item.creators.length > 3 ? ' et al.' : ''}
                                </span>
                              )}
                              {item.year && <span className="zotero-item-year">{item.year}</span>}
                              {item.publicationTitle && (
                                <span className="zotero-item-pub">{item.publicationTitle}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {totalPages > 1 && (
                      <div className="zotero-pagination">
                        <button disabled={page === 0} onClick={() => setPage((/** @type {any} */ p) => p - 1)}>
                          Previous
                        </button>
                        <span>
                          Page {page + 1} of {totalPages}
                        </span>
                        <button disabled={page >= totalPages - 1} onClick={() => setPage((/** @type {any} */ p) => p + 1)}>
                          Next
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Field exclusion options */}
            <div className="zotero-fields-section">
              <button className="zotero-fields-toggle" onClick={() => setShowFieldOptions((/** @type {any} */ v) => !v)}>
                <ChevronRightIcon
                  style={{ transform: showFieldOptions ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
                />
                Exclude fields
                {excludedFields.size > 0 && <span className="zotero-fields-count">{excludedFields.size}</span>}
              </button>
              {showFieldOptions && (
                <div className="zotero-fields-list">
                  {EXCLUDABLE_FIELDS.map((/** @type {any} */ f) => (
                    <label key={f.key} className="zotero-field-option">
                      <input type="checkbox" checked={excludedFields.has(f.key)} onChange={() => toggleField(f.key)} />
                      {f.label}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {duplicateWarning && (
              <div className="zotero-duplicate-warning">
                <p>
                  {duplicateWarning.keys.length === 1
                    ? `The key "${duplicateWarning.keys[0]}" already exists in your .bib file.`
                    : `${duplicateWarning.keys.length} keys already exist in your .bib file: ${duplicateWarning.keys.join(', ')}`}
                </p>
                <div className="zotero-duplicate-actions">
                  <button className="zotero-cancel-btn" onClick={() => setDuplicateWarning(null)}>
                    Cancel import
                  </button>
                  <button
                    className="auth-button"
                    onClick={() => {
                      onInsert(duplicateWarning.bibtex);
                      onClose();
                    }}
                  >
                    Import anyway
                  </button>
                </div>
              </div>
            )}
            <div className="zotero-footer">
              {!bibFileExists && <span className="zotero-warning">No .bib file found — one will be created.</span>}
              <button className="zotero-cancel-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="auth-button zotero-import-btn"
                onClick={handleImport}
                disabled={selectedKeys.size === 0 || importing}
              >
                {importing
                  ? 'Importing...'
                  : `Import ${selectedKeys.size} reference${selectedKeys.size !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
