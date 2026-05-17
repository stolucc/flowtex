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

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset URL to / before each test
    window.history.replaceState(null, '', '/');
    pushStateSpy = vi.spyOn(window.history, 'pushState');
    vi.spyOn(window.history, 'replaceState');
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

it('handleSave honours explicit fileId so a debounced save targets the original file even after the active file changes', async () => {
    // Regression test for a data-loss bug: a 1-second debounced save
    // captured the editor's content but resolved the target file from
    // React's `activeFile`. Switching files within the debounce window
    // wrote the previous file's text to the new file's id.
    put.mockResolvedValue({});
    const f1 = { id: 'f1', path: 'ref.bib', content: 'old bib' };
    const f2 = { id: 'f2', path: 'main.tex', content: 'old tex' };
    get.mockImplementation((url) => {
      if (url.includes('/files')) return Promise.resolve({ json: () => Promise.resolve([f1, f2]) });
      if (url.includes('/members')) return Promise.resolve({ json: () => Promise.resolve([]) });
      return Promise.resolve({ json: () => Promise.resolve([]) });
    });

    const { result } = renderHook(() => useProject({ id: 'u1', name: 'User' }));
    act(() => {
      result.current.selectProject({ id: 'p1', name: 'P' });
    });
    await act(async () => { await Promise.resolve(); });
    act(() => { result.current.switchFile(f1); });
    // User switches to main.tex *before* the bib's debounced save fires.
    act(() => { result.current.switchFile(f2); });
    await act(async () => {
      await result.current.handleSave('formatted bib content', f1.id);
    });

    expect(put).toHaveBeenCalledWith('/api/projects/files/f1', { content: 'formatted bib content' });
    // main.tex must NOT have been overwritten with the bib content.
    expect(put).not.toHaveBeenCalledWith('/api/projects/files/f2', expect.objectContaining({ content: 'formatted bib content' }));
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

  it('handleSetMainFile calls patch and updates project.main_file on success', async () => {
    patch.mockResolvedValue({ ok: true });
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

  it('handleSetMainFile throws and leaves project.main_file unchanged on PATCH failure', async () => {
    patch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Only the owner can modify these settings' }),
    });
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
      await expect(result.current.handleSetMainFile('other.tex')).rejects.toThrow(
        'Only the owner can modify these settings',
      );
    });

    expect(result.current.project.main_file).toBe('main.tex');
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

    // Folder delete is now a single atomic call to the folders endpoint
    // (it deletes both the folder row and every file under the prefix on
    // the server side), replacing the previous per-file DELETE loop.
    expect(del).toHaveBeenCalledWith('/api/projects/p1/folders', { path: 'chapters' });
    expect(result.current.files).toHaveLength(1);
    expect(result.current.files[0].id).toBe('f1');
    // Should have switched away from deleted file
    expect(result.current.activeFile.id).toBe('f1');
  });
});
