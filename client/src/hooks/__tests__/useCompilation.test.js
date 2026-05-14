import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useCompilation from '../useCompilation.js';

vi.mock('../../api.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
}));

import { get, post } from '../../api.js';

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    MockEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  set onerror(fn) {
    this._onerror = fn;
  }
  get onerror() {
    return this._onerror;
  }
  close() {
    this.closed = true;
  }
}
MockEventSource.instances = [];

vi.stubGlobal('EventSource', MockEventSource);

describe('useCompilation', () => {
  const project = { id: 'p1' };
  const activeFile = { id: 'f1', path: 'main.tex', content: 'hello' };
  let handleSave;
  let editorRef;

  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.instances = [];
    handleSave = vi.fn().mockResolvedValue(undefined);
    editorRef = {
      current: {
        getContent: vi.fn(() => 'editor content'),
        getTcMarks: vi.fn(() => []),
      },
    };
    get.mockResolvedValue({ json: () => Promise.resolve({ files: [] }) });
    post.mockResolvedValue({});
    // Clear localStorage to avoid lint side effects
    localStorage.clear();
  });

  it('has correct initial state', () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    expect(result.current.compiling).toBe(false);
    expect(result.current.pdfUrl).toBeNull();
    expect(result.current.compileLog).toBe('');
    expect(result.current.consoleOutput).toBe('');
  });

  it('handleCompile saves before compiling and opens EventSource', async () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    // Start compile (don't await - it blocks until EventSource resolves)
    let compilePromise;
    act(() => {
      compilePromise = result.current.handleCompile();
    });

    // Should have saved first, pinned to the active file's id so the save can't drift
    // to a different file if the user switches mid-compile. Marks ride along to keep
    // the server's tc_marks in sync with the just-saved content.
    await waitFor(() => {
      expect(handleSave).toHaveBeenCalledWith('editor content', 'f1', []);
    });

    // EventSource should be created
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/compile/p1/compile-stream');
    // setCompiling(true) runs in handleCompile's async continuation, outside
    // the test's act() wrapper — React 19's renderHook doesn't reflect that
    // render synchronously, so poll for it.
    await waitFor(() => {
      expect(result.current.compiling).toBe(true);
    });

    // Complete the compile by firing done event
    const es = MockEventSource.instances[0];
    act(() => {
      es.listeners.done({ data: JSON.stringify({ success: true, log: 'Done.' }) });
    });

    await act(async () => {
      await compilePromise;
    });
  });

  it('handleCompile output event appends to consoleOutput', async () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    let compilePromise;
    act(() => {
      compilePromise = result.current.handleCompile();
    });

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];

    act(() => {
      es.listeners.output({ data: JSON.stringify({ text: 'line 1\n' }) });
    });
    expect(result.current.consoleOutput).toBe('line 1\n');

    act(() => {
      es.listeners.output({ data: JSON.stringify({ text: 'line 2\n' }) });
    });
    expect(result.current.consoleOutput).toBe('line 1\nline 2\n');

    // Clean up
    act(() => {
      es.listeners.done({ data: JSON.stringify({ success: true, log: '' }) });
    });
    await act(async () => {
      await compilePromise;
    });
  });

  it('handleCompile done event (success) sets pdfUrl and compileLog', async () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    let compilePromise;
    act(() => {
      compilePromise = result.current.handleCompile();
    });

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];

    act(() => {
      es.listeners.done({ data: JSON.stringify({ success: true, log: 'Compilation successful' }) });
    });

    await act(async () => {
      await compilePromise;
    });

    expect(result.current.compileLog).toBe('Compilation successful');
    expect(result.current.pdfUrl).toMatch(/^\/api\/compile\/p1\/pdf\?t=\d+$/);
    expect(result.current.compiling).toBe(false);
  });

  it('handleCompile done event (failure) sets compileLog, pdfUrl unchanged', async () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    let compilePromise;
    act(() => {
      compilePromise = result.current.handleCompile();
    });

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];

    act(() => {
      es.listeners.done({ data: JSON.stringify({ success: false, log: 'Error on line 5' }) });
    });

    await act(async () => {
      await compilePromise;
    });

    expect(result.current.compileLog).toBe('Error on line 5');
    expect(result.current.pdfUrl).toBeNull();
    expect(result.current.compiling).toBe(false);
  });

  it('handleCompile error sets compileLog to error message', async () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    let compilePromise;
    act(() => {
      compilePromise = result.current.handleCompile();
    });

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];

    act(() => {
      es.onerror();
    });

    await act(async () => {
      await compilePromise;
    });

    expect(result.current.compileLog).toBe('Compile stream failed');
    expect(result.current.compiling).toBe(false);
  });

  it('handleStopCompile closes EventSource and calls stop endpoint', async () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    // Start compile
    let compilePromise;
    act(() => {
      compilePromise = result.current.handleCompile();
    });

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const es = MockEventSource.instances[0];

    await act(async () => {
      await result.current.handleStopCompile();
    });

    expect(es.closed).toBe(true);
    expect(post).toHaveBeenCalledWith('/api/compile/p1/stop');
    expect(result.current.compiling).toBe(false);

    // Clean up the hanging promise - the EventSource was closed so onerror fires
    act(() => {
      // The promise is still pending; the error handler was set before close
      // but since compileSourceRef is now null, it will reject
      if (es._onerror) es._onerror();
    });
    try {
      await compilePromise;
    } catch {}
  });

  it('prevents double compile', async () => {
    const { result } = renderHook(() => useCompilation(project, activeFile, handleSave, editorRef));

    // Start first compile
    let compilePromise;
    act(() => {
      compilePromise = result.current.handleCompile();
    });

    await waitFor(() => expect(result.current.compiling).toBe(true));

    // Try second compile - should be ignored
    act(() => {
      result.current.handleCompile();
    });

    // Should still only have 1 EventSource
    expect(MockEventSource.instances).toHaveLength(1);

    // Clean up
    const es = MockEventSource.instances[0];
    act(() => {
      es.listeners.done({ data: JSON.stringify({ success: true, log: '' }) });
    });
    await act(async () => {
      await compilePromise;
    });
  });
});
