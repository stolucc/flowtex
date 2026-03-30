import React, { useState, useCallback, useEffect, useRef } from 'react';
import ConfirmDialog from './ConfirmDialog.jsx';
import useClickOutside from '../hooks/useClickOutside.js';

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

export default function FileTree({
  files,
  activeFile,
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
}) {
  const [newFileName, setNewFileName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState('file');
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [emptyFolders, setEmptyFolders] = useState([]);
  const [addingIn, setAddingIn] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, items }
  const [renaming, setRenaming] = useState(null); // { type: 'file'|'folder', id, path, currentName }
  const [confirmDelete, setConfirmDelete] = useState(null); // { message, onConfirm }
  const [overwriteConfirm, setOverwriteConfirm] = useState(null); // { fileName, existing, content }
  const [duplicateWarning, setDuplicateWarning] = useState(null); // string message
  const dragCounter = useRef(0);

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

  useEffect(() => {
    setEmptyFolders((prev) =>
      prev.filter((folder) => {
        return !files.some((f) => f.path.startsWith(folder + '/'));
      }),
    );
  }, [files]);

  const handleAdd = (e) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    if (addType === 'folder') {
      const folderPath = newFileName.trim();
      setEmptyFolders((prev) => (prev.includes(folderPath) ? prev : [...prev, folderPath]));
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
                setEmptyFolders((prev) => prev.filter((f) => f !== folderPath && !f.startsWith(folderPath + '/')));
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
        // Update empty folders
        setEmptyFolders((prev) =>
          prev.map((f) => {
            if (f === renaming.path) return newPath;
            if (f.startsWith(renaming.path + '/')) return newPath + f.slice(renaming.path.length);
            return f;
          }),
        );
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
        if (existing) {
          onOverwrite?.(existing.id, '');
        } else {
          onCreate(file.name, '');
        }
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
    [onCreate, onOverwrite],
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

      const droppedFiles = Array.from(e.dataTransfer.files);
      pendingDrops.current = droppedFiles.map((file) => ({
        file,
        existing: files.find((f) => f.path === file.name) || null,
      }));
      processNextDrop();
    },
    [files, processNextDrop],
  );

  const tree = buildTree(files, emptyFolders);

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
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
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
              className="file-tree-item file-tree-folder"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => toggleFolder(fullPath)}
              onContextMenu={(e) => handleFolderContextMenu(e, fullPath, node.name)}
            >
              <span className="file-tree-folder-arrow">{collapsed ? '▸' : '▾'}</span>
              <span className="file-tree-folder-icon">
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
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
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
      className={`file-tree ${dragging ? 'file-tree-drag-over' : ''}`}
      style={style}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="file-tree-header">
        <span>Files</span>
        <div className="file-tree-header-actions">
          <button
            className="file-tree-add"
            onClick={() => {
              setAdding(true);
              setAddType('folder');
              setNewFileName('');
            }}
            title="New folder"
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
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
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
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
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
      <div className="file-tree-list">{renderNode(tree, '', 0)}</div>
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
