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
  const [genContextMenu, setGenContextMenu] = useState(null);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showHelperGuide, setShowHelperGuide] = useState(false);
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
    showHelperGuide,
    setShowHelperGuide,
    visualMode,
    setVisualMode,
    showTrackedChangesInline,
    setShowTrackedChangesInline,
    showChangesPanel,
    setShowChangesPanel,
    changesPanelWidth,
    setChangesPanelWidth,
    theme,
    setTheme,
  };
}
