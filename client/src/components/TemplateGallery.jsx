import React, { useState, useEffect, useRef } from 'react';
import { get, post, put, del, getCsrfToken } from '../api.js';
import { ChevronLeftIcon, UploadIcon, TagIcon, CloseIcon } from './Icons.jsx';

const CATEGORY_ICONS = {
  Academic: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  ),
  Presentation: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  General: (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
};

export default function TemplateGallery({ onSelect, onBack }) {
  const [templates, setTemplates] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(null);
  const [filterTagId, setFilterTagId] = useState('All');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadTagIds, setUploadTagIds] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef(null);

  // Tag management state
  const [showTagManager, setShowTagManager] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#89b4fa');
  const [editingTag, setEditingTag] = useState(null);
  const [editTagName, setEditTagName] = useState('');
  const [editTagColor, setEditTagColor] = useState('');

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, template }
  const ctxMenuRef = useRef(null);

  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const TAG_COLORS = ['#89b4fa', '#a6e3a1', '#cba6f7', '#f38ba8', '#fab387', '#f9e2af', '#94e2d5', '#74c7ec'];

  const showToast = (message, type = 'error') => {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };

  const fetchTemplates = () => {
    get('/api/projects/templates')
      .then((r) => r.json())
      .then((data) => {
        setTemplates(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  const fetchTags = () => {
    get('/api/projects/template-tags')
      .then((r) => r.json())
      .then(setTags)
      .catch(() => {});
  };

  useEffect(() => {
    fetchTemplates();
    fetchTags();
  }, []);

  const filtered =
    filterTagId === 'All' ? templates : templates.filter((t) => t.tags?.some((tag) => tag.id === filterTagId));

  const handleSelect = async (template) => {
    setCreating(template.id);
    try {
      const res = await post('/api/projects/from-template', { templateId: template.id });
      const project = await res.json();
      onSelect(project);
    } catch {
      setCreating(null);
    }
  };

  const handleDelete = async (e, tmpl) => {
    e.stopPropagation();
    if (!confirm(`Delete template "${tmpl.name}"?`)) return;
    try {
      await del(`/api/projects/templates/${tmpl.id}`);
      setTemplates((prev) => prev.filter((t) => t.id !== tmpl.id));
    } catch {
      /* ignore */
    }
  };

  const handleUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadError('');
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      formData.append('name', uploadName || uploadFile.name.replace(/\.zip$/i, ''));
      formData.append('description', uploadDesc);
      formData.append('tagIds', JSON.stringify(uploadTagIds));
      const res = await fetch('/api/projects/templates/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Upload failed');
      }
      setShowUpload(false);
      setUploadFile(null);
      setUploadName('');
      setUploadDesc('');
      setUploadTagIds([]);
      fetchTemplates();
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const toggleUploadTag = (tagId) => {
    setUploadTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
  };

  // Tag management handlers
  const handleCreateTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    try {
      const res = await post('/api/projects/template-tags', { name, color: newTagColor });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to create tag');
        return;
      }
      const tag = await res.json();
      setTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
      setNewTagName('');
      setNewTagColor('#89b4fa');
    } catch {
      /* ignore */
    }
  };

  const handleUpdateTag = async () => {
    if (!editingTag) return;
    const name = editTagName.trim();
    if (!name) return;
    try {
      const res = await put(`/api/projects/template-tags/${editingTag.id}`, { name, color: editTagColor });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to update tag');
        return;
      }
      const updated = await res.json();
      setTags((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      // Also update tags in templates list
      setTemplates((prev) =>
        prev.map((tmpl) => ({
          ...tmpl,
          tags: tmpl.tags?.map((t) => (t.id === updated.id ? updated : t)),
        })),
      );
      setEditingTag(null);
    } catch {
      /* ignore */
    }
  };

  const handleDeleteTag = async (tagId) => {
    if (!confirm('Delete this tag? It will be removed from all templates.')) return;
    try {
      await del(`/api/projects/template-tags/${tagId}`);
      setTags((prev) => prev.filter((t) => t.id !== tagId));
      setTemplates((prev) =>
        prev.map((tmpl) => ({
          ...tmpl,
          tags: tmpl.tags?.filter((t) => t.id !== tagId),
        })),
      );
      if (filterTagId === tagId) setFilterTagId('All');
      if (editingTag?.id === tagId) setEditingTag(null);
    } catch {
      /* ignore */
    }
  };

  const startEditTag = (tag) => {
    setEditingTag(tag);
    setEditTagName(tag.name);
    setEditTagColor(tag.color);
  };

  // Context menu: right-click on a template card to assign tags
  const handleContextMenu = (e, tmpl) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, template: tmpl });
  };

  const handleCtxToggleTag = async (tagId) => {
    const tmpl = ctxMenu?.template;
    if (!tmpl) return;
    const currentTagIds = (tmpl.tags || []).map((t) => t.id);
    const newTagIds = currentTagIds.includes(tagId)
      ? currentTagIds.filter((id) => id !== tagId)
      : [...currentTagIds, tagId];
    try {
      const res = await put(`/api/projects/templates/${tmpl.id}/tags`, { tagIds: newTagIds });
      if (!res.ok) return;
      const updatedTags = await res.json();
      setTemplates((prev) => prev.map((t) => (t.id === tmpl.id ? { ...t, tags: updatedTags } : t)));
      // Keep context menu open but update its template reference
      setCtxMenu((prev) => (prev ? { ...prev, template: { ...tmpl, tags: updatedTags } } : null));
    } catch {
      /* ignore */
    }
  };

  // Close context menu on click outside
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = (e) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target)) {
        setCtxMenu(null);
      }
    };
    const handleEsc = (e) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [ctxMenu]);

  return (
    <div className="template-gallery">
      <div className="template-gallery-header">
        <button className="template-back-btn" onClick={onBack}>
          <ChevronLeftIcon size={16} />
          Back to Projects
        </button>
        <h2>New from Template</h2>
        <div className="template-header-actions">
          <button className="template-tag-manage-btn" onClick={() => setShowTagManager(true)} title="Manage tags">
            <TagIcon size={16} />
            Tags
          </button>
          <button
            className="template-upload-btn"
            onClick={() => {
              setUploadError('');
              setShowUpload(true);
            }}
          >
            <UploadIcon size={16} />
            Upload Template
          </button>
        </div>
      </div>

      <div className="template-categories">
        <button
          className={`template-category-btn ${filterTagId === 'All' ? 'active' : ''}`}
          onClick={() => setFilterTagId('All')}
        >
          All
        </button>
        {tags.map((tag) => (
          <button
            key={tag.id}
            className={`template-category-btn ${filterTagId === tag.id ? 'active' : ''}`}
            onClick={() => setFilterTagId(tag.id)}
            style={{ '--tag-color': tag.color }}
          >
            <span className="template-tag-dot" style={{ background: tag.color }} />
            {tag.name}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="template-loading">Loading templates...</div>
      ) : (
        <div className="template-grid">
          {filtered.map((t) => (
            <button
              key={t.id}
              className="template-card"
              disabled={creating !== null}
              onClick={() => handleSelect(t)}
              onContextMenu={(e) => handleContextMenu(e, t)}
            >
              <div className="template-card-preview">
                {t.preloaded ? (
                  <img src={`/thumbnails/${t.id}.png`} alt={`${t.name} preview`} />
                ) : (
                  <div className="template-card-preview-placeholder">
                    {CATEGORY_ICONS[t.category] || CATEGORY_ICONS.General}
                  </div>
                )}
              </div>
              <div className="template-card-body">
                <div className="template-card-name">{t.name}</div>
                <div className="template-card-desc">{t.description}</div>
                {t.tags?.length > 0 && (
                  <div className="template-card-tags">
                    {t.tags.map((tag) => (
                      <span key={tag.id} className="template-card-tag" style={{ '--tag-color': tag.color }}>
                        {tag.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="template-card-meta">
                  {t.fileCount} file{t.fileCount !== 1 ? 's' : ''}
                  {t.author_name && <> &middot; by {t.author_name}</>}
                </div>
              </div>
              {!t.preloaded && (
                <button className="template-card-delete" onClick={(e) => handleDelete(e, t)} title="Delete template">
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
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
              {creating === t.id && <div className="template-card-creating">Creating...</div>}
            </button>
          ))}
        </div>
      )}

      {/* Upload dialog */}
      {showUpload && (
        <div className="template-upload-overlay" onClick={() => setShowUpload(false)}>
          <div className="template-upload-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Upload Template</h3>
            <p className="template-upload-hint">Upload a ZIP file containing your template files.</p>

            <label className="template-upload-label">Name</label>
            <input
              type="text"
              className="template-upload-input"
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
              placeholder="Template name"
            />

            <label className="template-upload-label">Description</label>
            <input
              type="text"
              className="template-upload-input"
              value={uploadDesc}
              onChange={(e) => setUploadDesc(e.target.value)}
              placeholder="Brief description"
            />

            <label className="template-upload-label">Tags</label>
            <div className="template-upload-tags">
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className={`template-upload-tag ${uploadTagIds.includes(tag.id) ? 'selected' : ''}`}
                  style={{ '--tag-color': tag.color }}
                  onClick={() => toggleUploadTag(tag.id)}
                >
                  <span className="template-tag-dot" style={{ background: tag.color }} />
                  {tag.name}
                </button>
              ))}
              {tags.length === 0 && (
                <span className="template-upload-hint">No tags yet. Create some in the tag manager.</span>
              )}
            </div>

            <label className="template-upload-label">ZIP File</label>
            <div className="template-upload-file-row">
              <button className="template-upload-file-btn" onClick={() => fileInputRef.current?.click()}>
                Choose File
              </button>
              <span className="template-upload-file-name">{uploadFile ? uploadFile.name : 'No file chosen'}</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setUploadFile(f);
                    if (!uploadName) setUploadName(f.name.replace(/\.zip$/i, ''));
                  }
                  e.target.value = '';
                }}
              />
            </div>

            {uploadError && <div className="template-upload-error">{uploadError}</div>}

            <div className="template-upload-actions">
              <button className="template-upload-cancel" onClick={() => setShowUpload(false)}>
                Cancel
              </button>
              <button className="template-upload-submit" disabled={!uploadFile || uploading} onClick={handleUpload}>
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tag manager dialog */}
      {showTagManager && (
        <div className="template-upload-overlay" onClick={() => setShowTagManager(false)}>
          <div className="template-upload-dialog template-tag-manager" onClick={(e) => e.stopPropagation()}>
            <h3>Manage Tags</h3>

            <div className="template-tag-list">
              {tags.map((tag) => (
                <div key={tag.id} className="template-tag-row">
                  {editingTag?.id === tag.id ? (
                    <>
                      <input
                        type="text"
                        className="template-tag-edit-input"
                        value={editTagName}
                        onChange={(e) => setEditTagName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleUpdateTag()}
                      />
                      <div className="template-tag-color-picker">
                        {TAG_COLORS.map((c) => (
                          <button
                            key={c}
                            className={`template-tag-color-swatch ${editTagColor === c ? 'active' : ''}`}
                            style={{ background: c }}
                            onClick={() => setEditTagColor(c)}
                          />
                        ))}
                      </div>
                      <div className="template-tag-row-actions">
                        <button className="template-tag-save-btn" onClick={handleUpdateTag}>
                          Save
                        </button>
                        <button className="template-tag-cancel-btn" onClick={() => setEditingTag(null)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="template-tag-dot" style={{ background: tag.color }} />
                      <span className="template-tag-name">{tag.name}</span>
                      <div className="template-tag-row-actions">
                        <button className="template-tag-edit-btn" onClick={() => startEditTag(tag)} title="Edit tag">
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
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          className="template-tag-delete-btn"
                          onClick={() => handleDeleteTag(tag.id)}
                          title="Delete tag"
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
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
              {tags.length === 0 && <div className="template-tag-empty">No tags yet.</div>}
            </div>

            <div className="template-tag-create">
              <input
                type="text"
                className="template-tag-edit-input"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="New tag name"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateTag()}
              />
              <div className="template-tag-color-picker">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`template-tag-color-swatch ${newTagColor === c ? 'active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setNewTagColor(c)}
                  />
                ))}
              </div>
              <button className="template-tag-add-btn" onClick={handleCreateTag} disabled={!newTagName.trim()}>
                Add Tag
              </button>
            </div>

            <div className="template-upload-actions">
              <button className="template-upload-cancel" onClick={() => setShowTagManager(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu for tag assignment */}
      {ctxMenu && (
        <div ref={ctxMenuRef} className="template-ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }}>
          <div className="template-ctx-menu-header">Tags</div>
          {tags.length === 0 && <div className="template-ctx-menu-empty">No tags yet</div>}
          {tags.map((tag) => {
            const active = (ctxMenu.template.tags || []).some((t) => t.id === tag.id);
            return (
              <button
                key={tag.id}
                className={`template-ctx-menu-item ${active ? 'active' : ''}`}
                onClick={() => handleCtxToggleTag(tag.id)}
              >
                <span className="template-ctx-menu-check">
                  {active && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span className="template-tag-dot" style={{ background: tag.color }} />
                {tag.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div className={`template-toast template-toast-${toast.type}`}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{toast.message}</span>
          <button className="template-toast-close" onClick={() => setToast(null)}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
