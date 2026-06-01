import { useState, useEffect } from 'react';

/** Read the persisted theme preference, defaulting to 'dark'. */
function initialTheme() {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem('flowtex-theme');
  return stored === 'light' || stored === 'dark' ? stored : 'dark';
}

/** Centralises all UI visibility/layout state: panel widths, modal toggles, and history view state. */
export default function useUIState() {
  // Theme: 'dark' (default) | 'light'. Applied to <html> via data-theme so
  // every var()-based color in app.css switches simultaneously. Persisted
  // to localStorage so the choice survives reloads.
  const [theme, setTheme] = useState(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('flowtex-theme', theme);
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, [theme]);

  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [showFiles, setShowFiles] = useState(true);
  const [commentsWidth, setCommentsWidth] = useState(260);
  const [showComments, setShowComments] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [wordWrap, setWordWrap] = useState(true);
  const [pdfWidth, setPdfWidth] = useState(null);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showGitHubSync, setShowGitHubSync] = useState(false);
  const [showBibEnrich, setShowBibEnrich] = useState(false);
  const [showZotero, setShowZotero] = useState(false);
  const [showCompareFiles, setShowCompareFiles] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyEditedFileIds, setHistoryEditedFileIds] = useState([]);
  const [historyFiles, setHistoryFiles] = useState(null);
  const [historySelectedFile, setHistorySelectedFile] = useState(null);
  const [genPanelHeight, setGenPanelHeight] = useState(150);
  const [outlinePanelHeight, setOutlinePanelHeight] = useState(200);
  const [genContextMenu, setGenContextMenu] = useState(null);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [visualMode, setVisualMode] = useState(false);
  // V2: tracked-changes display options (Word-style "Display for Review").
  // - showTrackedChangesInline: when false, the editor hides ins/del
  //   decorations so the doc reads like the final version. Marks are
  //   still tracked underneath.
  // - showChangesPanel: when true, a side panel of cards appears with
  //   each pending change + Accept/Reject controls.
  const [showTrackedChangesInline, setShowTrackedChangesInline] = useState(true);
  const [showChangesPanel, setShowChangesPanel] = useState(false);
  const [changesPanelWidth, setChangesPanelWidth] = useState(280);

  // Layout: 'split' (default) | 'editor' (PDF hidden) | 'pdf' (editor hidden).
  // Initialised from ?layout= so opening a project in a new tab with
  // "Open PDF in new tab" lands directly in the PDF-only view, AND so a
  // hard refresh keeps whatever the user last picked.
  const initialLayout = (() => {
    if (typeof window === 'undefined') return 'split';
    const fromUrl = new URLSearchParams(window.location.search).get('layout');
    return fromUrl === 'editor' || fromUrl === 'pdf' ? fromUrl : 'split';
  })();
  const [layoutMode, setLayoutModeRaw] = useState(initialLayout);
  // Wrapper: when the user changes layout from the menu, mirror the new
  // value into the URL so a refresh restores it. Default ('split') is
  // represented by removing the param so the URL stays clean.
  const setLayoutMode = (next) => {
    setLayoutModeRaw(next);
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      if (next === 'split') url.searchParams.delete('layout');
      else url.searchParams.set('layout', next);
      window.history.replaceState({}, '', url);
    } catch {
      /* ignore — replaceState is best-effort */
    }
  };

  return {
    fileTreeWidth,
    setFileTreeWidth,
    showFiles,
    setShowFiles,
    commentsWidth,
    setCommentsWidth,
    showComments,
    setShowComments,
    showLineNumbers,
    setShowLineNumbers,
    wordWrap,
    setWordWrap,
    pdfWidth,
    setPdfWidth,
    showShareModal,
    setShowShareModal,
    showGitHubSync,
    setShowGitHubSync,
    showBibEnrich,
    setShowBibEnrich,
    showZotero,
    setShowZotero,
    showCompareFiles,
    setShowCompareFiles,
    showHistory,
    setShowHistory,
    historyEditedFileIds,
    setHistoryEditedFileIds,
    historyFiles,
    setHistoryFiles,
    historySelectedFile,
    setHistorySelectedFile,
    genPanelHeight,
    setGenPanelHeight,
    genContextMenu,
    setGenContextMenu,
    showProjectSettings,
    setShowProjectSettings,
    showShortcuts,
    setShowShortcuts,
    showAbout,
    setShowAbout,
    showBugReport,
    setShowBugReport,
    visualMode,
    setVisualMode,
    showTrackedChangesInline,
    setShowTrackedChangesInline,
    showChangesPanel,
    setShowChangesPanel,
    changesPanelWidth,
    setChangesPanelWidth,
    outlinePanelHeight,
    setOutlinePanelHeight,
    layoutMode,
    setLayoutMode,
    theme,
    setTheme,
  };
}
