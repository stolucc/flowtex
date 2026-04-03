import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useProject from '../useProject.js';

vi.mock('../../api.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

import { get, post, put, patch, del } from '../../api.js';

describe('useProject', () => {
  let pushStateSpy;
  let replaceStateSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset URL to / before each test
    window.history.replaceState(null, '', '/');
    pushStateSpy = vi.spyOn(window.history, 'pushState');
    replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    // Default: no projects to load from URL
    get.mockResolvedValue({ json: () => Promise.resolve([]) });
  });

  it('has correct initial state', () => {
    const { result } = renderHook(() => useProject(null));

    expect(result.current.project).toBeNull();
    expect(result.current.files).toEqual([]);
    expect(result.current.activeFile).toBeNull();
    expect(result.current.members).toEqual([]);
  });

  it('selectProject sets project and calls pushState', () => {
    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));

    const proj = { id: 'p1', name: 'Test Project' };
    act(() => {
      result.current.selectProject(proj);
    });

    expect(result.current.project).toEqual(proj);
    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/project/p1');
  });

  it('goBack clears project, files, activeFile, and navigates to /', async () => {
    const files = [{ id: 'f1', path: 'main.tex', content: '' }];
    get.mockImplementation((url) => {
      if (url.includes('/files')) return Promise.resolve({ json: () => Promise.resolve(files) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));

    act(() => {
      result.current.selectProject({ id: 'p1', name: 'Test' });
    });

    await waitFor(() => {
      expect(result.current.files.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.goBack();
    });

    expect(result.current.project).toBeNull();
    expect(result.current.files).toEqual([]);
    expect(result.current.activeFile).toBeNull();
    expect(pushStateSpy).toHaveBeenCalledWith(null, '', '/');
  });

  it('handleSave calls put with correct URL and body, updates file content', async () => {
    put.mockResolvedValue({});
    const file = { id: 'f1', path: 'main.tex', content: 'old' };

    const files = [file];
    get.mockImplementation((url) => {
      if (url.includes('/files')) return Promise.resolve({ json: () => Promise.resolve(files) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));

    act(() => {
      result.current.selectProject({ id: 'p1', name: 'Test', main_file: 'main.tex' });
    });

    await waitFor(() => {
      expect(result.current.activeFile).not.toBeNull();
    });

    await act(async () => {
      await result.current.handleSave('new content');
    });

    expect(put).toHaveBeenCalledWith('/api/projects/files/f1', { content: 'new content' });
    expect(result.current.activeFile.content).toBe('new content');
    expect(result.current.files[0].content).toBe('new content');
  });

  it('handleSave includes tcPositions when provided', async () => {
    put.mockResolvedValue({});
    const file = { id: 'f1', path: 'main.tex', content: 'old' };
    get.mockImplementation((url) => {
      if (url.includes('/files')) return Promise.resolve({ json: () => Promise.resolve([file]) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'T', main_file: 'main.tex' });
    });
    await waitFor(() => expect(result.current.activeFile).not.toBeNull());

    const tcPositions = [{ from: 0, to: 5 }];
    await act(async () => {
      await result.current.handleSave('new', tcPositions);
    });

    expect(put).toHaveBeenCalledWith('/api/projects/files/f1', { content: 'new', tcPositions });
  });

  it('handleCreateFile calls post, adds file, switches to new file', async () => {
    const newFile = { id: 'f2', path: 'chapter.tex', content: 'hello' };
    post.mockResolvedValue({ json: () => Promise.resolve(newFile) });
    get.mockImplementation((url) => {
      if (url.includes('/files'))
        return Promise.resolve({ json: () => Promise.resolve([{ id: 'f1', path: 'main.tex', content: '' }]) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'T', main_file: 'main.tex' });
    });
    await waitFor(() => expect(result.current.activeFile).not.toBeNull());

    await act(async () => {
      await result.current.handleCreateFile('chapter.tex', 'hello');
    });

    expect(post).toHaveBeenCalledWith('/api/projects/p1/files', { path: 'chapter.tex', content: 'hello' });
    expect(result.current.files).toHaveLength(2);
    expect(result.current.activeFile).toEqual(newFile);
  });

  it('handleDeleteFile removes file and switches if active file deleted', async () => {
    del.mockResolvedValue({});
    const f1 = { id: 'f1', path: 'main.tex', content: '' };
    const f2 = { id: 'f2', path: 'other.tex', content: '' };
    get.mockImplementation((url) => {
      if (url.includes('/files')) return Promise.resolve({ json: () => Promise.resolve([f1, f2]) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'T', main_file: 'main.tex' });
    });
    await waitFor(() => expect(result.current.files).toHaveLength(2));

    // Active file should be f1 (main.tex)
    expect(result.current.activeFile.id).toBe('f1');

    await act(async () => {
      await result.current.handleDeleteFile('f1');
    });

    expect(del).toHaveBeenCalledWith('/api/projects/files/f1');
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].id).toBe('f2');
    // Should have switched to remaining file
    expect(result.current.activeFile.id).toBe('f2');
  });

  it('handleRenameFile calls patch and updates path in files', async () => {
    patch.mockResolvedValue({});
    const f1 = { id: 'f1', path: 'old.tex', content: '' };
    get.mockImplementation((url) => {
      if (url.includes('/files')) return Promise.resolve({ json: () => Promise.resolve([f1]) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'T' });
    });
    await waitFor(() => expect(result.current.files).toHaveLength(1));

    await act(async () => {
      await result.current.handleRenameFile('f1', 'new.tex');
    });

    expect(patch).toHaveBeenCalledWith('/api/projects/files/f1', { path: 'new.tex' });
    expect(result.current.files[0].path).toBe('new.tex');
  });

  it('handleSetMainFile calls patch and updates project.main_file', async () => {
    patch.mockResolvedValue({});
    get.mockImplementation((url) => {
      if (url.includes('/files'))
        return Promise.resolve({ json: () => Promise.resolve([{ id: 'f1', path: 'main.tex', content: '' }]) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'T', main_file: 'main.tex' });
    });
    await waitFor(() => expect(result.current.project).not.toBeNull());

    await act(async () => {
      await result.current.handleSetMainFile('other.tex');
    });

    expect(patch).toHaveBeenCalledWith('/api/projects/p1', { main_file: 'other.tex' });
    expect(result.current.project.main_file).toBe('other.tex');
  });

  it('switchFile sets activeFile and updates URL search params', async () => {
    get.mockImplementation((url) => {
      if (url.includes('/files'))
        return Promise.resolve({
          json: () =>
            Promise.resolve([
              { id: 'f1', path: 'main.tex', content: '' },
              { id: 'f2', path: 'other.tex', content: '' },
            ]),
        });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'T', main_file: 'main.tex' });
    });
    await waitFor(() => expect(result.current.files).toHaveLength(2));

    const f2 = { id: 'f2', path: 'other.tex', content: '' };
    act(() => {
      result.current.switchFile(f2);
    });

    expect(result.current.activeFile).toEqual(f2);
    expect(window.location.search).toContain('file=f2');
  });

  it('handleDeleteFolder deletes all files with prefix and switches if active in folder', async () => {
    del.mockResolvedValue({});
    const f1 = { id: 'f1', path: 'main.tex', content: '' };
    const f2 = { id: 'f2', path: 'chapters/ch1.tex', content: '' };
    const f3 = { id: 'f3', path: 'chapters/ch2.tex', content: '' };
    get.mockImplementation((url) => {
      if (url.includes('/files')) return Promise.resolve({ json: () => Promise.resolve([f1, f2, f3]) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'T', main_file: 'main.tex' });
    });
    await waitFor(() => expect(result.current.files).toHaveLength(3));

    // Switch to a file in the folder to be deleted
    act(() => {
      result.current.switchFile(f2);
    });

    await act(async () => {
      await result.current.handleDeleteFolder('chapters');
    });

    expect(del).toHaveBeenCalledWith('/api/projects/files/f2');
    expect(del).toHaveBeenCalledWith('/api/projects/files/f3');
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].id).toBe('f1');
    // Should have switched away from deleted file
    expect(result.current.activeFile.id).toBe('f1');
  });
});
