import React, { lazy, Suspense } from 'react';
import { get, post, put, patch } from '../api.js';
import { resolveUsedFiles } from '@shared/texDeps.js';
import { useEditorRef } from '../contexts/EditorRefContext.jsx';
import { useProjectContext } from '../contexts/ProjectContext.jsx';

// Every editor-level modal is lazy. The previously-static four
// (ShareModal, CompareFilesModal, ProjectSettingsModal, WordCountModal)
// were the bulk of an otherwise-unused chunk of code shipped on every
// initial page load — splitting them shrinks the main bundle and only
// pays the cost when the user actually opens the modal.
const ShareModal = lazy(() => import('./ShareModal.jsx'));
const CompareFilesModal = lazy(() => import('./CompareFilesModal.jsx'));
const ProjectSettingsModal = lazy(() => import('./ProjectSettingsModal.jsx'));
const WordCountModal = lazy(() => import('./WordCountModal.jsx'));
const GitHubSyncModal = lazy(() => import('./GitHubSyncModal.jsx'));
const BibEnrichModal = lazy(() => import('./BibEnrichModal.jsx'));
const ZoteroModal = lazy(() => import('./ZoteroModal.jsx'));

/** Centralized container that conditionally renders all editor-level modals (share, settings, shortcuts, etc.). */
export default function ModalContainer({
  user,
  ui,
  trackChangesMode,
  setTrackChangesMode,
  githubLink,
  setGithubLink,
  hasGithubToken,
  handleDiff,
  handleSave,
  wordCountState,
  setWordCountState,
  projectSettingsTab,
  setProjectSettingsTab,
}) {
  const editorRef = useEditorRef();
  const {
    project,
    setProject,
    files,
    setFiles,
    activeFile,
    setActiveFile,
    members,
    setMembers,
    switchFile,
  } = useProjectContext();

  return (
    <>
      {ui.showShareModal && (
        <Suspense fallback={null}>
          <ShareModal
            projectId={project.id}
            onClose={() => {
              ui.setShowShareModal(false);
              get(`/api/projects/${project.id}/members`)
                .then((r) => r.json())
                .then(setMembers)
                .catch((e) => console.warn('Failed to reload members:', e));
            }}
          />
        </Suspense>
      )}
      {ui.showProjectSettings && (
        <Suspense fallback={null}>
          <ProjectSettingsModal
            project={project}
            files={files}
            isOwner={members.some((m) => m.id === user?.id && m.role === 'owner')}
            onClose={() => {
              ui.setShowProjectSettings(false);
              setProjectSettingsTab(null);
            }}
            onUpdate={(updated) => setProject((p) => ({ ...p, ...updated }))}
            trackChangesMode={trackChangesMode}
            onTrackChangesChange={setTrackChangesMode}
            autoSaveOn={!!githubLink?.autoPush}
            onAutoSaveChange={async (val) => {
              await patch(`/api/github/link/${project.id}/auto-push`, { enabled: val });
              setGithubLink((prev) => (prev ? { ...prev, autoPush: val } : prev));
            }}
            githubLinked={!!hasGithubToken && !!githubLink?.linked}
            initialTab={projectSettingsTab}
          />
        </Suspense>
      )}
      {wordCountState.open && (
        <Suspense fallback={null}>
          <WordCountModal
            data={wordCountState.data}
            loading={wordCountState.loading}
            error={wordCountState.error}
            onClose={() => setWordCountState((s) => ({ ...s, open: false }))}
          />
        </Suspense>
      )}
      {ui.showShortcuts && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) ui.setShowShortcuts(false);
          }}
        >
          <div className="modal shortcuts-modal">
            <div className="modal-header">
              <h2>Keyboard Shortcuts</h2>
              <button className="modal-close" onClick={() => ui.setShowShortcuts(false)}>
                &times;
              </button>
            </div>
            <div className="shortcuts-body">
              <table className="shortcuts-table">
                <tbody>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>S</kbd>
                    </td>
                    <td>Save &amp; Compile</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>F</kbd>
                    </td>
                    <td>Find &amp; Replace</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Z</kbd>
                    </td>
                    <td>Undo</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd>
                    </td>
                    <td>Redo</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>B</kbd>
                    </td>
                    <td>Bold selection</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>I</kbd>
                    </td>
                    <td>Italicize selection</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + Click
                    </td>
                    <td>Comment on selection</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>/</kbd>
                    </td>
                    <td>Toggle comment</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Tab</kbd>
                    </td>
                    <td>Indent selection</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">
                      <kbd>Shift</kbd> + <kbd>Tab</kbd>
                    </td>
                    <td>Unindent selection</td>
                  </tr>
                  <tr>
                    <td className="shortcut-key">Click on PDF</td>
                    <td>Jump to source (SyncTeX)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {ui.showAbout && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) ui.setShowAbout(false);
          }}
        >
          <div className="modal about-modal">
            <div className="modal-header">
              <h2>About FlowTex</h2>
              <button className="modal-close" onClick={() => ui.setShowAbout(false)}>
                &times;
              </button>
            </div>
            <div className="about-body">
              <p className="about-tagline">A collaborative LaTeX editor</p>
              <p className="about-version">Built with React, CodeMirror, and TeX Live</p>
              {/* Build identifier — injected by the `build` script as
                  VITE_BUILD_SHA (short git SHA) / VITE_BUILD_TIME (ISO). Lets
                  an operator confirm which version is actually deployed. */}
              <p className="about-build">
                <span className="about-build-label">Build</span>{' '}
                <code className="about-build-sha">{import.meta.env.VITE_BUILD_SHA || 'dev'}</code>
                {import.meta.env.VITE_BUILD_TIME && (
                  <>
                    {' · '}
                    <time dateTime={import.meta.env.VITE_BUILD_TIME}>
                      {new Date(import.meta.env.VITE_BUILD_TIME).toLocaleString()}
                    </time>
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      )}
      {ui.showCompareFiles && (
        <Suspense fallback={null}>
          <CompareFilesModal
            projectId={project.id}
            files={files}
            onClose={() => ui.setShowCompareFiles(false)}
            onStartDiff={handleDiff}
          />
        </Suspense>
      )}
      {ui.showGitHubSync && (
        <Suspense fallback={null}>
          <GitHubSyncModal
            projectId={project.id}
            projectName={project.name}
            onClose={() => ui.setShowGitHubSync(false)}
            onFilesUpdated={(newFiles) => setFiles(newFiles)}
            onLinkChanged={(linkData) => setGithubLink(linkData)}
          />
        </Suspense>
      )}
      {ui.showBibEnrich && activeFile?.path?.endsWith('.bib') && (
        <Suspense fallback={null}>
          <BibEnrichModal
            file={activeFile}
            onClose={() => ui.setShowBibEnrich(false)}
            onApply={(newContent) => {
              handleSave(newContent, activeFile.id);
              setFiles((prev) => prev.map((f) => (f.id === activeFile.id ? { ...f, content: newContent } : f)));
              setActiveFile((prev) => (prev ? { ...prev, content: newContent } : prev));
            }}
          />
        </Suspense>
      )}
      {ui.showZotero && (
        <Suspense fallback={null}>
          <ZoteroModal
            onClose={() => ui.setShowZotero(false)}
            bibFileExists={files.some((f) => f.path.endsWith('.bib'))}
            existingBibKeys={(() => {
              const re = /@\w+\s*\{\s*([\w:.@/+-]+)/g;
              const keys = [];
              for (const f of files) {
                if (!f.path.endsWith('.bib') || !f.content) continue;
                let m;
                re.lastIndex = 0;
                while ((m = re.exec(f.content)) !== null) keys.push(m[1]);
              }
              return keys;
            })()}
            onInsert={async (bibtex) => {
              // Find the first .bib file actually referenced from the main file
              const mainFile = project?.main_file || 'main.tex';
              const usedPaths = resolveUsedFiles(files, mainFile);
              let bibFile =
                files.find((f) => f.path.endsWith('.bib') && usedPaths.has(f.path)) ||
                files.find((f) => f.path.endsWith('.bib'));
              if (!bibFile) {
                try {
                  const res = await post(`/api/projects/${project.id}/files`, {
                    path: 'references.bib',
                    content: bibtex,
                  });
                  const newFile = await res.json();
                  setFiles((prev) => [...prev, newFile]);
                  switchFile(newFile);
                } catch (e) {
                  console.error('Failed to create .bib file', e);
                }
                return;
              }
              const newContent = bibFile.content.trimEnd() + '\n\n' + bibtex;
              const targetId = bibFile.id;
              setFiles((prev) => prev.map((f) => (f.id === targetId ? { ...f, content: newContent } : f)));
              // Only update the editor view if it's still showing this file —
              // a setTimeout here previously raced a file switch and could
              // overwrite the wrong file's editor content.
              if (activeFile?.id === targetId) {
                setActiveFile((prev) => (prev ? { ...prev, content: newContent } : prev));
                editorRef.current?.replaceContent?.(newContent);
              }
              await put(`/api/projects/files/${targetId}`, { content: newContent });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
