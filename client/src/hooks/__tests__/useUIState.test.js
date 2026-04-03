import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useUIState from '../useUIState.js';

describe('useUIState', () => {
  it('returns all expected state and setter keys', () => {
    const { result } = renderHook(() => useUIState());

    const expectedKeys = [
      'fileTreeWidth',
      'setFileTreeWidth',
      'showFiles',
      'setShowFiles',
      'commentsWidth',
      'setCommentsWidth',
      'showComments',
      'setShowComments',
      'showLineNumbers',
      'setShowLineNumbers',
      'wordWrap',
      'setWordWrap',
      'pdfWidth',
      'setPdfWidth',
      'showShareModal',
      'setShowShareModal',
      'showGitHubSync',
      'setShowGitHubSync',
      'showBibEnrich',
      'setShowBibEnrich',
      'showZotero',
      'setShowZotero',
      'showCompareFiles',
      'setShowCompareFiles',
      'showHistory',
      'setShowHistory',
      'historyEditedFileIds',
      'setHistoryEditedFileIds',
      'historyFiles',
      'setHistoryFiles',
      'historySelectedFile',
      'setHistorySelectedFile',
      'genPanelHeight',
      'setGenPanelHeight',
      'genContextMenu',
      'setGenContextMenu',
      'showProjectSettings',
      'setShowProjectSettings',
      'showShortcuts',
      'setShowShortcuts',
      'showAbout',
      'setShowAbout',
    ];

    for (const key of expectedKeys) {
      expect(result.current).toHaveProperty(key);
    }
  });

  it('has correct default values', () => {
    const { result } = renderHook(() => useUIState());

    expect(result.current.fileTreeWidth).toBe(200);
    expect(result.current.showFiles).toBe(true);
    expect(result.current.commentsWidth).toBe(260);
    expect(result.current.showComments).toBe(false);
    expect(result.current.showLineNumbers).toBe(true);
    expect(result.current.wordWrap).toBe(true);
    expect(result.current.pdfWidth).toBeNull();
    expect(result.current.showShareModal).toBe(false);
    expect(result.current.showGitHubSync).toBe(false);
    expect(result.current.showBibEnrich).toBe(false);
    expect(result.current.showZotero).toBe(false);
    expect(result.current.showCompareFiles).toBe(false);
    expect(result.current.showHistory).toBe(false);
    expect(result.current.historyEditedFileIds).toEqual([]);
    expect(result.current.historyFiles).toBeNull();
    expect(result.current.historySelectedFile).toBeNull();
    expect(result.current.genPanelHeight).toBe(150);
    expect(result.current.genContextMenu).toBeNull();
    expect(result.current.showProjectSettings).toBe(false);
    expect(result.current.showShortcuts).toBe(false);
    expect(result.current.showAbout).toBe(false);
  });

  it('setShowFiles toggles showFiles', () => {
    const { result } = renderHook(() => useUIState());
    expect(result.current.showFiles).toBe(true);

    act(() => {
      result.current.setShowFiles(false);
    });
    expect(result.current.showFiles).toBe(false);

    act(() => {
      result.current.setShowFiles(true);
    });
    expect(result.current.showFiles).toBe(true);
  });

  it('setFileTreeWidth updates value', () => {
    const { result } = renderHook(() => useUIState());

    act(() => {
      result.current.setFileTreeWidth(300);
    });
    expect(result.current.fileTreeWidth).toBe(300);
  });

  it('setShowComments updates value', () => {
    const { result } = renderHook(() => useUIState());

    act(() => {
      result.current.setShowComments(true);
    });
    expect(result.current.showComments).toBe(true);
  });

  it('setPdfWidth updates value', () => {
    const { result } = renderHook(() => useUIState());

    act(() => {
      result.current.setPdfWidth(500);
    });
    expect(result.current.pdfWidth).toBe(500);
  });

  it('setShowShareModal updates value', () => {
    const { result } = renderHook(() => useUIState());

    act(() => {
      result.current.setShowShareModal(true);
    });
    expect(result.current.showShareModal).toBe(true);
  });

  it('setGenPanelHeight updates value', () => {
    const { result } = renderHook(() => useUIState());

    act(() => {
      result.current.setGenPanelHeight(250);
    });
    expect(result.current.genPanelHeight).toBe(250);
  });

  it('setHistoryEditedFileIds updates value', () => {
    const { result } = renderHook(() => useUIState());

    act(() => {
      result.current.setHistoryEditedFileIds(['f1', 'f2']);
    });
    expect(result.current.historyEditedFileIds).toEqual(['f1', 'f2']);
  });
});
