import React, { useState, useCallback, useEffect, useRef } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';
import useClickOutside from '../hooks/useClickOutside.js';
import { CloseIcon, FolderIcon } from './Icons.jsx';
import { getSetting, setSetting } from '../utils/settings.js';
import { useAlert } from '../contexts/AlertContext.jsx';

/**
 * Builds a nested directory tree structure from a flat file list and empty folder paths.
 * @param {Array} files - Flat array of file objects with path properties
 * @param {string[]} emptyFolders - Folder paths that should appear even without files
 * @returns {Object} Root tree node with children and files properties
 */
function buildTree(files, emptyFolders) {
  const root = { name: '', children: {}, files: [] };

  for (const folderPath of emptyFolders) {
    const parts = folderPath.split('/');
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {}, files: [] };
      }
      node = node.children[part];
    }
  }

  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children[parts[i]]) {
        node.children[parts[i]] = { name: parts[i], children: {}, files: [] };
      }
      node = node.children[parts[i]];
    }
    node.files.push(f);
  }
  return root;
}

function getFileIcon(path) {
  if (path.endsWith('.tex')) return 'T';
  if (path.endsWith('.bib')) return 'B';
  if (path.endsWith('.sty') || path.endsWith('.cls')) return 'S';
  return 'F';
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.eps', '.svg', '.tiff', '.tif'];
const STYLE_EXTS = ['.sty', '.cls', '.clo', '.bst', '.def', '.fd', '.cfg', '.bbx', '.cbx', '.lbx'];

const FILE_CATEGORIES = [
  { key: 'tex', label: 'TeX Files', test: (p) => p.endsWith('.tex') },
  { key: 'bib', label: 'Bibliography', test: (p) => p.endsWith('.bib') },
  {
    key: 'images',
    label: 'Images',
    test: (p) => {
      const ext = p.substring(p.lastIndexOf('.')).toLowerCase();
      return IMAGE_EXTS.includes(ext) || ext === '.pdf';
    },
  },
  {
    key: 'style',
    label: 'Style Files',
    test: (p) => {
      const ext = p.substring(p.lastIndexOf('.')).toLowerCase();
      return STYLE_EXTS.includes(ext);
    },
  },
];

/**
 * Groups files into predefined categories (TeX, Bibliography, Images, Style, Other).
 * @param {Array} files - Flat array of file objects
 * @returns {Object} Map from category key to file array
 */
function categorizeFiles(files) {
  const groups = {};
  for (const cat of FILE_CATEGORIES) groups[cat.key] = [];
  groups.other = [];
  for (const f of files) {
    const cat = FILE_CATEGORIES.find((c) => c.test(f.path));
    groups[cat ? cat.key : 'other'].push(f);
  }
  return groups;
}

/** Positioned right-click context menu for file and folder actions. */
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useClickOutside(ref, onClose);

  return (
    <div ref={ref} className="file-tree-context-menu" style={{ top: y, left: x }}>
      {items.map((item, i) => (
        <button
          key={i}
          className={`file-tree-context-item ${item.danger ? 'danger' : ''}`}
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Project file browser with drag-and-drop upload, folder nesting, rename, and type-based grouping. */
export default function FileTree({
  files,
  activeFile,
  groupByType: groupByTypeProp,
  onSelect,
  onCreate,
  onOverwrite,
  onDelete,
  onRename,
  onRenameFolder,
  onDeleteFolder,
  onSetMainFile,
  mainFile,
  style,
  startAdding,
  startAddingFolder,
  onDownload,
  onPrettyPrint,
  onCollapse,
  onUploadBinary,
  emptyFolders: emptyFoldersProp,
  onCreateFolder,
}) {
  const { alert: showAlert } = useAlert();
  const [groupByType, setGroupByType] = useState(() => {
    if (groupByTypeProp !== undefined) return groupByTypeProp;
    const stored = getSetting('group-files');
    return stored !== null ? stored === 'true' : true;
  });
  const [newFileName, setNewFileName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState('file');
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [collapsedCategories, setCollapsedCategories] = useState({});
  // Server-backed list of explicit empty folders. Source of truth lives in
  // useProject; this component just reads it and calls onCreateFolder /
  // onDeleteFolder / onRenameFolder to mutate. Folders that *do* contain
  // files are added to the tree by buildTree from each file's path; this
  // list is only for the empty ones.
  const emptyFolders = emptyFoldersProp || [];
  const [addingIn, setAddingIn] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, items }
  const [renaming, setRenaming] = useState(null); // { type: 'file'|'folder', id, path, currentName }
  const [confirmDelete, setConfirmDelete] = useState(null); // { message, onConfirm }
  const [overwriteConfirm, setOverwriteConfirm] = useState(null); // { fileName, existing, content }
  const [duplicateWarning, setDuplicateWarning] = useState(null); // string message
  const dragCounter = useRef(0);

  // ── Internal drag-and-drop (move file / move folder) ─────────────────
  // Distinguished from OS-file drops by a custom MIME type; the existing
  // upload-on-drop handler only fires when `dataTransfer.types` includes
  // 'Files'. dropTargetPath: null = no hover, '' = root, 'parts' = folder.
  const [dropTargetPath, setDropTargetPath] = useState(null);
  const dragSourceRef = useRef(null);
  const INTERNAL_DRAG_TYPE = 'application/x-flowtex-move';
  const isInternalDrag = (e) => e.dataTransfer?.types?.includes(INTERNAL_DRAG_TYPE);
  const internalSourcePayload = (e) => {
    if (dragSourceRef.current) return dragSourceRef.current;
    try {
      return JSON.parse(e.dataTransfer.getData(INTERNAL_DRAG_TYPE));
    } catch {
      return null;
    }
  };
  const canDropOn = (src, targetPath /* '' = root */) => {
    if (!src) return false;
    if (src.kind === 'folder') {
      if (targetPath === src.path) return false; // onto itself
      if (targetPath === '' && !src.path.includes('/')) return false; // already at root
      if (targetPath.startsWith(src.path + '/')) return false; // into descendant
      return true;
    }
    if (src.kind === 'file') {
      const currentDir = src.path.includes('/') ? src.path.slice(0, src.path.lastIndexOf('/')) : '';
      if (targetPath === currentDir) return false; // already there
      return true;
    }
    return false;
  };
  const performInternalDrop = (src, targetPath) => {
    if (src.kind === 'file') {
      const fileName = src.path.split('/').pop();
      const newPath = targetPath ? `${targetPath}/${fileName}` : fileName;
      if (newPath === src.path) return;
      if (files.some((f) => f.path === newPath && f.id !== src.id)) {
        showAlert(`A file already exists at ${newPath}.`, { title: 'Move blocked' });
        return;
      }
      onRename?.(src.id, newPath);
    } else if (src.kind === 'folder') {
      const folderName = src.path.split('/').pop();
      const newPrefix = targetPath ? `${targetPath}/${folderName}` : folderName;
      if (newPrefix === src.path) return;
      // No descendant move (also guarded in canDropOn).
      if (newPrefix.startsWith(src.path + '/')) return;
      // Collision check across all files: any file path at-or-under newPrefix
      // that isn't itself part of the moving folder.
      const movingPrefix = src.path + '/';
      const conflict = files.some(
        (f) =>
          (f.path === newPrefix || f.path.startsWith(newPrefix + '/')) &&
          !(f.path === src.path || f.path.startsWith(movingPrefix)),
      );
      if (conflict) {
        showAlert(`A file or folder already exists at ${newPrefix}.`, { title: 'Move blocked' });
        return;
      }
      onRenameFolder?.(src.path, newPrefix);
    }
  };
  const onItemDragStart = (payload) => (e) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(payload));
    dragSourceRef.current = payload;
  };
  const onItemDragEnd = () => {
    dragSourceRef.current = null;
    setDropTargetPath(null);
  };
  const onFolderDragOver = (folderPath) => (e) => {
    if (!isInternalDrag(e)) return; // let OS-file overlay logic handle it
    const src = dragSourceRef.current;
    if (!canDropOn(src, folderPath)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetPath(folderPath);
  };
  const onFolderDragLeave = (e) => {
    if (!isInternalDrag(e)) return;
    e.stopPropagation();
    // Don't unconditionally null — children of the folder fire leave too. We
    // clear on dragend / drop / root-dragover.
  };
  const onFolderDrop = (folderPath) => (e) => {
    if (!isInternalDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const src = internalSourcePayload(e);
    setDropTargetPath(null);
    dragSourceRef.current = null;
    if (canDropOn(src, folderPath)) performInternalDrop(src, folderPath);
  };

  useEffect(() => {
    if (startAdding) {
      setAdding(true);
      setAddType('file');
      setNewFileName('');
    }
  }, [startAdding]);

  useEffect(() => {
    if (startAddingFolder) {
      setAdding(true);
      setAddType('folder');
      setNewFileName('');
    }
  }, [startAddingFolder]);

  const handleAdd = (e) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    if (addType === 'folder') {
      const folderPath = newFileName.trim();
      // Persist server-side; useProject's onCreateFolder updates the
      // emptyFolders prop, which triggers the re-render with the new
      // folder visible.
      onCreateFolder?.(folderPath);
      setCollapsedFolders((s) => ({ ...s, [folderPath]: false }));
      setAddingIn(folderPath);
      setNewFileName('');
      setAdding(false);
    } else {
      const name = newFileName.trim();
      if (files.some((f) => f.path === name)) {
        setDuplicateWarning(`"${name}" already exists.`);
        return;
      }
      onCreate(name);
      setNewFileName('');
      setAdding(false);
    }
  };

  const handleCreateInFolder = (folderPath, fileName) => {
    const filePath = folderPath ? folderPath + '/' + fileName : fileName;
    if (files.some((f) => f.path === filePath)) {
      setDuplicateWarning(`"${filePath}" already exists.`);
      return;
    }
    onCreate(filePath);
    setAddingIn(null);
  };

  const toggleFolder = useCallback((path) => {
    setCollapsedFolders((s) => ({ ...s, [path]: !s[path] }));
  }, []);

  const handleContextMenu = useCallback((e, items) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const handleFileContextMenu = useCallback(
    (e, file) => {
      const parentFolder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      const fileName = file.path.split('/').pop();
      const items = [];
      if (file.path.endsWith('.tex') && file.path !== mainFile) {
        items.push({
          label: 'Set as main file',
          action: () => onSetMainFile(file.path),
        });
      }
      if (file.path.endsWith('.bib') && onPrettyPrint) {
        items.push({
          label: 'Prettify',
          action: () => onPrettyPrint(file),
        });
      }
      items.push(
        {
          label: 'Download',
          action: () => onDownload && onDownload(file),
        },
        {
          label: 'Rename',
          action: () =>
            setRenaming({ type: 'file', id: file.id, path: file.path, parentFolder, currentName: fileName }),
        },
        {
          label: 'Delete',
          danger: true,
          action: () =>
            setConfirmDelete({
              message: `Are you sure you want to delete "${fileName}"?`,
              onConfirm: () => {
                onDelete(file.id);
                setConfirmDelete(null);
              },
            }),
        },
      );
      handleContextMenu(e, items);
    },
    [handleContextMenu, onDelete, onSetMainFile, mainFile, onDownload, onPrettyPrint],
  );

  const handleFolderContextMenu = useCallback(
    (e, folderPath, folderName) => {
      const parentFolder = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';
      handleContextMenu(e, [
        {
          label: 'New file',
          action: () => {
            setCollapsedFolders((s) => ({ ...s, [folderPath]: false }));
            setAddingIn(folderPath);
          },
        },
        {
          label: 'Rename',
          action: () => setRenaming({ type: 'folder', path: folderPath, parentFolder, currentName: folderName }),
        },
        {
          label: 'Delete',
          danger: true,
          action: () =>
            setConfirmDelete({
              message: `Are you sure you want to delete the folder "${folderName}" and all its contents?`,
              onConfirm: () => {
                onDeleteFolder(folderPath);
                setConfirmDelete(null);
              },
            }),
        },
      ]);
    },
    [handleContextMenu, onDeleteFolder],
  );

  const handleRenameSubmit = useCallback(
    (newName) => {
      if (!renaming || !newName.trim() || newName.trim() === renaming.currentName) {
        setRenaming(null);
        return;
      }
      const trimmed = newName.trim();
      if (renaming.type === 'file') {
        const newPath = renaming.parentFolder ? renaming.parentFolder + '/' + trimmed : trimmed;
        onRename(renaming.id, newPath);
      } else {
        const newPath = renaming.parentFolder ? renaming.parentFolder + '/' + trimmed : trimmed;
        onRenameFolder(renaming.path, newPath);
      }
      setRenaming(null);
    },
    [renaming, onRename, onRenameFolder],
  );

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    // Internal move: if no folder under the cursor claimed it, the root
    // container is the implicit drop zone (= move to top level).
    if (isInternalDrag(e)) {
      const src = dragSourceRef.current;
      if (canDropOn(src, '')) {
        e.dataTransfer.dropEffect = 'move';
        setDropTargetPath((cur) => (cur == null ? '' : cur));
      }
    }
  }, []);

  const processDroppedFile = useCallback(
    (file, existing) => {
      const binaryExts = [
        '.pdf',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.bmp',
        '.eps',
        '.zip',
        '.tar',
        '.gz',
        '.exe',
        '.woff',
        '.woff2',
        '.ttf',
        '.otf',
      ];
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      if (binaryExts.includes(ext) && !file.type.startsWith('text/')) {
        onUploadBinary?.(file, file.name);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          if (existing) {
            onOverwrite?.(existing.id, reader.result);
          } else {
            onCreate(file.name, reader.result);
          }
        };
        reader.readAsText(file);
      }
    },
    [onCreate, onOverwrite, onUploadBinary],
  );

  const pendingDrops = useRef([]);

  const processNextDrop = useCallback(() => {
    while (pendingDrops.current.length > 0) {
      const { file, existing } = pendingDrops.current.shift();
      if (existing) {
        setOverwriteConfirm({ fileName: file.name, existing, file });
        return; // wait for user response
      }
      processDroppedFile(file, null);
    }
  }, [processDroppedFile]);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      dragCounter.current = 0;

      // Internal move-to-root drop. A folder row's onDrop calls
      // stopPropagation, so this branch only runs when the user released
      // outside any folder row.
      if (isInternalDrag(e)) {
        const src = internalSourcePayload(e);
        setDropTargetPath(null);
        dragSourceRef.current = null;
        if (canDropOn(src, '')) performInternalDrop(src, '');
        return;
      }

      const droppedFiles = Array.from(e.dataTransfer.files);
      pendingDrops.current = droppedFiles.map((file) => ({
        file,
        existing: files.find((f) => f.path === file.name) || null,
      }));
      processNextDrop();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files, processNextDrop, onRename, onRenameFolder],
  );

  const fileGroups = groupByType ? categorizeFiles(files) : null;

  const renderNode = (node, fullPath, depth) => {
    const isRoot = fullPath === '';
    const collapsed = !isRoot && !!collapsedFolders[fullPath];

    const sortedFolders = Object.keys(node.children).sort();
    const sortedFiles = [...node.files].sort((a, b) => {
      const aName = a.path.split('/').pop();
      const bName = b.path.split('/').pop();
      return aName.localeCompare(bName);
    });
    const childDepth = depth + (isRoot ? 0 : 1);

    const isRenamingThisFolder = renaming && renaming.type === 'folder' && renaming.path === fullPath;

    return (
      <React.Fragment key={fullPath || '__root__'}>
        {!isRoot &&
          (isRenamingThisFolder ? (
            <div className="file-tree-item file-tree-folder" style={{ paddingLeft: 8 + depth * 14 }}>
              <span className="file-tree-folder-arrow">▾</span>
              <span className="file-tree-folder-icon">
                <FolderIcon size={14} />
              </span>
              <form
                className="file-tree-rename-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRenameSubmit(e.target.querySelector('input').value);
                }}
              >
                <input
                  className="file-tree-rename-input"
                  defaultValue={renaming.currentName}
                  autoFocus
                  onBlur={(e) => handleRenameSubmit(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              </form>
            </div>
          ) : (
            <div
              className={`file-tree-item file-tree-folder${
                dropTargetPath === fullPath ? ' file-tree-drop-target' : ''
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
              draggable
              onDragStart={onItemDragStart({ kind: 'folder', path: fullPath })}
              onDragEnd={onItemDragEnd}
              onDragOver={onFolderDragOver(fullPath)}
              onDragLeave={onFolderDragLeave}
              onDrop={onFolderDrop(fullPath)}
              onClick={() => toggleFolder(fullPath)}
              onContextMenu={(e) => handleFolderContextMenu(e, fullPath, node.name)}
            >
              <span className="file-tree-folder-arrow">{collapsed ? '▸' : '▾'}</span>
              <span className="file-tree-folder-icon">
                <FolderIcon size={14} />
              </span>
              <span className="file-tree-name">{node.name}</span>
              <button
                className="file-tree-folder-add"
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsedFolders((s) => ({ ...s, [fullPath]: false }));
                  setAddingIn(fullPath);
                }}
                title="New file in folder"
              >
                +
              </button>
            </div>
          ))}
        {!collapsed && (
          <>
            {addingIn === fullPath && (
              <form
                className="file-tree-new"
                style={{ paddingLeft: 8 + childDepth * 14 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const val = e.target.querySelector('input').value.trim();
                  if (val) handleCreateInFolder(fullPath, val);
                }}
              >
                <input
                  type="text"
                  placeholder="filename.tex"
                  autoFocus
                  onBlur={(e) => {
                    if (!e.target.value.trim()) setAddingIn(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setAddingIn(null);
                  }}
                />
              </form>
            )}
            {sortedFolders.map((folderName) => {
              const childPath = fullPath ? fullPath + '/' + folderName : folderName;
              return renderNode(node.children[folderName], childPath, childDepth);
            })}
            {sortedFiles.map((f) => {
              const fileName = f.path.split('/').pop();
              const isRenamingThis = renaming && renaming.type === 'file' && renaming.id === f.id;

              return (
                <div
                  key={f.id}
                  className={`file-tree-item ${activeFile?.id === f.id ? 'active' : ''}`}
                  style={{ paddingLeft: 8 + childDepth * 14 }}
                  draggable={!isRenamingThis}
                  onDragStart={onItemDragStart({ kind: 'file', id: f.id, path: f.path })}
                  onDragEnd={onItemDragEnd}
                  onClick={() => !isRenamingThis && onSelect(f)}
                  onContextMenu={(e) => handleFileContextMenu(e, f)}
                >
                  <span className="file-tree-icon">{getFileIcon(f.path)}</span>
                  {isRenamingThis ? (
                    <form
                      className="file-tree-rename-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleRenameSubmit(e.target.querySelector('input').value);
                      }}
                    >
                      <input
                        className="file-tree-rename-input"
                        defaultValue={renaming.currentName}
                        autoFocus
                        onBlur={(e) => handleRenameSubmit(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </form>
                  ) : (
                    <>
                      <span className={`file-tree-name ${f.path === mainFile ? 'main-file' : ''}`}>{fileName}</span>
                      {files.length > 1 && (
                        <button
                          className="file-tree-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDelete({
                              message: `Are you sure you want to delete "${fileName}"?`,
                              onConfirm: () => {
                                onDelete(f.id);
                                setConfirmDelete(null);
                              },
                            });
                          }}
                        >
                          &times;
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
      </React.Fragment>
    );
  };

  return (
    <div
      className={`file-tree${dragging ? ' file-tree-drag-over' : ''}${
        dropTargetPath === '' ? ' file-tree-drop-target-root' : ''
      }`}
      style={style}
      // axe a11y: scrollable regions need keyboard focus so users on
      // screen readers / keyboard-only navigation can scroll the file list.
      tabIndex={0}
      role="region"
      aria-label="Project files"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="file-tree-header">
        <span>Files</span>
        <div className="file-tree-header-actions">
          <button
            className={`file-tree-add ${groupByType ? 'active' : ''}`}
            onClick={() => {
              setGroupByType((v) => {
                const next = !v;
                setSetting('group-files', next);
                return next;
              });
            }}
            title={groupByType ? 'Show flat list' : 'Group by type'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
              <line x1="9" y1="6" x2="9" y2="6.01" />
              <line x1="9" y1="12" x2="9" y2="12.01" />
              <line x1="9" y1="18" x2="9" y2="18.01" />
            </svg>
          </button>
          <button
            className="file-tree-add"
            onClick={() => {
              setAdding(true);
              setAddType('folder');
              setNewFileName('');
            }}
            title="New folder"
          >
            <FolderIcon size={14} />
          </button>
          <button
            className="file-tree-add"
            onClick={() => {
              setAdding(true);
              setAddType('file');
              setNewFileName('');
            }}
            title="New file"
          >
            +
          </button>
          {onCollapse && (
            <button className="file-tree-add" onClick={onCollapse} title="Close file panel">
              <CloseIcon />
            </button>
          )}
        </div>
      </div>
      {adding && (
        <form className="file-tree-new" onSubmit={handleAdd}>
          <input
            type="text"
            placeholder={addType === 'folder' ? 'folder name' : 'filename.tex'}
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAdding(false);
              }
            }}
            onBlur={() => {
              if (!newFileName.trim()) setAdding(false);
            }}
            autoFocus
          />
        </form>
      )}
      <div className="file-tree-list">
        {groupByType && fileGroups
          ? [...FILE_CATEGORIES, { key: 'other', label: 'Other' }].map((cat) => {
              const groupFiles = fileGroups[cat.key];
              if (!groupFiles || groupFiles.length === 0) return null;
              const collapsed = !!collapsedCategories[cat.key];
              const catTree = buildTree(groupFiles, cat.key === 'other' ? emptyFolders : []);
              return (
                <React.Fragment key={cat.key}>
                  <div
                    className="file-tree-category"
                    onClick={() => setCollapsedCategories((s) => ({ ...s, [cat.key]: !s[cat.key] }))}
                  >
                    <span className="file-tree-category-arrow">{collapsed ? '▸' : '▾'}</span>
                    <span className="file-tree-category-label">{cat.label}</span>
                    <span className="file-tree-category-count">{groupFiles.length}</span>
                  </div>
                  {!collapsed && renderNode(catTree, '', 0)}
                </React.Fragment>
              );
            })
          : renderNode(buildTree(files, emptyFolders), '', 0)}
      </div>
      {dragging && <div className="file-tree-drop-overlay">Drop files here</div>}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          message={confirmDelete.message}
          onConfirm={confirmDelete.onConfirm}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {overwriteConfirm && (
        <ConfirmDialog
          message={`"${overwriteConfirm.fileName}" already exists. Overwrite it?`}
          confirmLabel="Overwrite"
          confirmClass="confirm-dialog-delete"
          onConfirm={() => {
            processDroppedFile(overwriteConfirm.file, overwriteConfirm.existing);
            setOverwriteConfirm(null);
            processNextDrop();
          }}
          onCancel={() => {
            setOverwriteConfirm(null);
            processNextDrop();
          }}
        />
      )}
      {duplicateWarning && (
        <div className="modal-overlay confirm-dialog-overlay" onClick={() => setDuplicateWarning(null)}>
          <div className="modal-card confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog-message">{duplicateWarning}</p>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-cancel" onClick={() => setDuplicateWarning(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
