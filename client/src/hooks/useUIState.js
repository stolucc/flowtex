import { useState } from 'react';

export default function useUIState() {
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
  };
}
