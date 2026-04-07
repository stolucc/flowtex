import React, { lazy, Suspense } from 'react';
import { get, getCsrfToken } from '../api.js';

const HistoryPanel = lazy(() => import('./HistoryPanel.jsx'));

/** Layout wrapper for the history mode, showing a file list alongside the HistoryPanel. */
export default function HistoryView({
  project,
  files,
  activeFile,
  user,
  ui,
  historyVersion,
  setProject,
  setFiles,
  setActiveFile,
  editorRef,
}) {
  return (
    <>
      <div
        className="file-panel history-file-panel"
        style={{ width: ui.fileTreeWidth, display: 'flex', flexDirection: 'column', flexShrink: 0 }}
      >
        <div
          className="file-tree-header"
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--border)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          Files
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {(ui.historyFiles || files).map((f) => (
            <div
              key={f.id}
              className={`history-file-item ${ui.historySelectedFile?.id === f.id ? 'active' : ''}`}
              onClick={() => ui.setHistorySelectedFile({ id: f.id, path: f.path })}
              style={{
                padding: '4px 12px',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--text-primary)',
                cursor: 'pointer',
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.path}
              </span>
              {ui.historyEditedFileIds.includes(f.id) && <span className="history-file-edited-badge">Edited</span>}
            </div>
          ))}
        </div>
      </div>
      <Suspense fallback={null}>
        <HistoryPanel
          projectId={project.id}
          currentUserName={user?.name}
          historyFileId={ui.historySelectedFile?.id}
          historyFilePath={ui.historySelectedFile?.path}
          refreshKey={historyVersion}
          snapshotInterval={project.snapshot_interval_sec || 30}
          onSnapshotIntervalChange={async (val) => {
            await fetch(`/api/projects/${project.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
              credentials: 'include',
              body: JSON.stringify({ snapshot_interval_sec: val }),
            });
            setProject((p) => ({ ...p, snapshot_interval_sec: val }));
          }}
          onClose={() => {
            ui.setShowHistory(false);
            ui.setHistoryEditedFileIds([]);
            ui.setHistoryFiles(null);
            ui.setHistorySelectedFile(null);
          }}
          onRestore={(restoredFiles) => {
            setFiles(restoredFiles);
            ui.setShowHistory(false);
            ui.setHistoryEditedFileIds([]);
            ui.setHistoryFiles(null);
            ui.setHistorySelectedFile(null);
            const stillExists = restoredFiles.find((f) => f.id === activeFile?.id);
            if (stillExists) {
              setActiveFile(stillExists);
              setTimeout(() => editorRef.current?.replaceContent(stillExists.content), 50);
            } else if (restoredFiles.length > 0) {
              const mainFile = restoredFiles.find((f) => f.path === (project?.main_file || 'main.tex'));
              setActiveFile(mainFile || restoredFiles[0]);
              setTimeout(() => editorRef.current?.replaceContent((mainFile || restoredFiles[0]).content), 50);
            } else setActiveFile(null);
          }}
          onSelectVersion={async (snapshot) => {
            ui.setHistorySelectedFile(null);
            try {
              const res = await get(`/api/history/snapshot/${snapshot.id}`);
              const data = await res.json();
              ui.setHistoryEditedFileIds(data.editedFileIds || []);
              ui.setHistoryFiles(data.files || null);
              if (data.editedFileIds?.length > 0) {
                const firstEdited = data.files?.find((f) => f.id === data.editedFileIds[0]);
                if (firstEdited) ui.setHistorySelectedFile({ id: firstEdited.id, path: firstEdited.path });
              }
            } catch {
              ui.setHistoryEditedFileIds([]);
              ui.setHistoryFiles(null);
            }
          }}
        />
      </Suspense>
    </>
  );
}
