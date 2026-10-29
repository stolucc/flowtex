// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import FileTree from '../FileTree.jsx';
import { AlertProvider } from '../../contexts/AlertContext.jsx';

afterEach(cleanup);

// Mock useClickOutside so context menu doesn't auto-dismiss
vi.mock('../../hooks/useClickOutside.js', () => ({
  default: vi.fn(),
}));

const makeFile = (id, path) => ({ id, path });

function renderFileTree(overrides = {}) {
  const defaultProps = {
    files: [makeFile('1', 'main.tex'), makeFile('2', 'refs.bib'), makeFile('3', 'images/fig1.png')],
    activeFile: null,
    groupByType: false,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onSetMainFile: vi.fn(),
    mainFile: 'main.tex',
    onDownload: vi.fn(),
    onOverwrite: vi.fn(),
    ...overrides,
  };
  return {
    ...render(
      <AlertProvider>
        <FileTree {...defaultProps} />
      </AlertProvider>,
    ),
    props: defaultProps,
  };
}

describe('FileTree', () => {
  it('renders without crashing', () => {
    renderFileTree();
  });

  it('renders the Files header', () => {
    renderFileTree();
    expect(screen.getByText('Files')).toBeTruthy();
  });

  it('renders file names', () => {
    renderFileTree();
    expect(screen.getByText('main.tex')).toBeTruthy();
    expect(screen.getByText('refs.bib')).toBeTruthy();
  });

  it('renders folder for files with / in path', () => {
    renderFileTree();
    expect(screen.getByText('images')).toBeTruthy();
    expect(screen.getByText('fig1.png')).toBeTruthy();
  });

  it('calls onSelect when a file is clicked', () => {
    const { props } = renderFileTree();
    fireEvent.click(screen.getByText('main.tex'));
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: '1', path: 'main.tex' }));
  });

  it('highlights the active file', () => {
    const activeFile = makeFile('2', 'refs.bib');
    const { container } = renderFileTree({ activeFile });
    const activeItem = container.querySelector('.file-tree-item.active');
    expect(activeItem).toBeTruthy();
    expect(activeItem.textContent).toContain('refs.bib');
  });

  it('shows new file input when + button is clicked', () => {
    const { container } = renderFileTree();
    const addBtn = container.querySelector('button[title="New file"]');
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn);
    const input = container.querySelector('.file-tree-new input');
    expect(input).toBeTruthy();
    expect(input.getAttribute('placeholder')).toBe('filename.tex');
  });

  it('shows new folder input when folder button is clicked', () => {
    const { container } = renderFileTree();
    const folderBtn = container.querySelector('button[title="New folder"]');
    expect(folderBtn).toBeTruthy();
    fireEvent.click(folderBtn);
    const input = container.querySelector('.file-tree-new input');
    expect(input).toBeTruthy();
    expect(input.getAttribute('placeholder')).toBe('folder name');
  });

  it('calls onCreate when new file form is submitted', () => {
    const { props, container } = renderFileTree();
    const addBtn = container.querySelector('button[title="New file"]');
    fireEvent.click(addBtn);
    const input = container.querySelector('.file-tree-new input');
    fireEvent.change(input, { target: { value: 'chapter1.tex' } });
    fireEvent.submit(input.closest('form'));
    expect(props.onCreate).toHaveBeenCalledWith('chapter1.tex');
  });

  it('shows context menu on right-click of a file', () => {
    renderFileTree();
    const fileEl = screen.getByText('main.tex');
    fireEvent.contextMenu(fileEl);
    // Context menu should show standard items
    expect(screen.getByText('Download')).toBeTruthy();
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('shows context menu on right-click of a folder', () => {
    renderFileTree();
    const folderEl = screen.getByText('images');
    fireEvent.contextMenu(folderEl);
    expect(screen.getByText('New file')).toBeTruthy();
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('shows delete button on file items when more than one file exists', () => {
    const { container } = renderFileTree();
    const deleteButtons = container.querySelectorAll('.file-tree-delete');
    expect(deleteButtons.length).toBeGreaterThan(0);
  });

  it('marks main file with main-file class', () => {
    const { container } = renderFileTree();
    const mainFileEl = container.querySelector('.main-file');
    expect(mainFileEl).toBeTruthy();
    expect(mainFileEl.textContent).toBe('main.tex');
  });

  it('renders with groupByType and shows categories', () => {
    renderFileTree({ groupByType: true });
    expect(screen.getByText('TeX Files')).toBeTruthy();
    expect(screen.getByText('Bibliography')).toBeTruthy();
  });

  it('collapses a folder when clicked', () => {
    renderFileTree();
    // fig1.png should be visible initially
    expect(screen.getByText('fig1.png')).toBeTruthy();
    // Click the folder to collapse
    fireEvent.click(screen.getByText('images'));
    // fig1.png should be hidden
    expect(screen.queryByText('fig1.png')).toBeNull();
  });
});

// Regression: with group-by-type ON (the default), empty folders were only
// attached to the "Other" category, and that category is skipped when it
// has no files -- so in a typical project (.tex/.bib/images only) a newly
// created folder was saved server-side but never rendered.
describe('FileTree — empty folders in group-by-type view', () => {
  it('shows an empty folder even when no file falls into "Other"', () => {
    renderFileTree({ groupByType: true, emptyFolders: ['chapters'] });
    expect(screen.getByText('chapters')).toBeTruthy();
  });

  it('shows nested empty folders', () => {
    renderFileTree({ groupByType: true, emptyFolders: ['notes/drafts'] });
    expect(screen.getByText('notes')).toBeTruthy();
  });

  it('does not render a stray "Other" section when there are no empty folders', () => {
    renderFileTree({ groupByType: true, emptyFolders: [] });
    expect(screen.queryByText('Other')).toBeNull();
  });

  it('still shows empty folders alongside real "Other" files', () => {
    renderFileTree({
      groupByType: true,
      files: [makeFile('1', 'main.tex'), makeFile('9', 'data.xyz')],
      emptyFolders: ['chapters'],
    });
    expect(screen.getByText('chapters')).toBeTruthy();
    expect(screen.getByText('data.xyz')).toBeTruthy();
  });
});

// Dropping a FOLDER from the OS used to read it as one fake zero-byte file
// and silently do nothing. Now the tree is walked and handed to
// onUploadFolder with relative paths; drops onto a folder row land in it.
describe('FileTree — dropping folders from the OS', () => {
  const fileEntry = (name) => {
    const file = new File(['x'], name);
    return { name, isFile: true, isDirectory: false, file: (ok) => ok(file) };
  };
  const dirEntry = (name, children) => ({
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let done = false;
      return { readEntries: (ok) => { ok(done ? [] : children); done = true; } };
    },
  });
  const osDrop = (entries) => ({
    types: ['Files'],
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files: entries.filter((e) => e.isFile).map((e) => new File(['x'], e.name)),
  });
  const root = () => screen.getByLabelText('Project files');

  it('folder dropped on the panel → onUploadFolder with relative paths', async () => {
    const onUploadFolder = vi.fn();
    const { props } = renderFileTree({ onUploadFolder });
    fireEvent.drop(root(), { dataTransfer: osDrop([dirEntry('images', [fileEntry('a.png'), dirEntry('sub', [fileEntry('b.png')])])]) });
    await vi.waitFor(() => expect(onUploadFolder).toHaveBeenCalled());
    expect(onUploadFolder.mock.calls[0][0].map((i) => i.path)).toEqual(['images/a.png', 'images/sub/b.png']);
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('drop onto a folder row uploads INTO that folder', async () => {
    const onUploadFolder = vi.fn();
    renderFileTree({ onUploadFolder });
    const row = screen.getByText('images').closest('.file-tree-folder');
    fireEvent.drop(row, { dataTransfer: osDrop([dirEntry('new', [fileEntry('c.png')]), fileEntry('d.png')]) });
    await vi.waitFor(() => expect(onUploadFolder).toHaveBeenCalled());
    expect(onUploadFolder.mock.calls[0][0].map((i) => i.path)).toEqual(['images/new/c.png', 'images/d.png']);
  });

  it('plain files dropped on the panel keep the per-file flow', async () => {
    const onUploadFolder = vi.fn();
    const onUploadBinary = vi.fn();
    renderFileTree({ onUploadFolder, onUploadBinary });
    fireEvent.drop(root(), { dataTransfer: osDrop([fileEntry('pic.png')]) });
    await vi.waitFor(() => expect(onUploadBinary).toHaveBeenCalled());
    expect(onUploadBinary.mock.calls[0][1]).toBe('pic.png');
    expect(onUploadFolder).not.toHaveBeenCalled();
  });

  it('highlights a folder row while OS files are dragged over it', () => {
    renderFileTree({ onUploadFolder: vi.fn() });
    const row = screen.getByText('images').closest('.file-tree-folder');
    fireEvent.dragOver(row, { dataTransfer: { types: ['Files'], dropEffect: 'none' } });
    expect(row.className).toContain('file-tree-drop-target');
  });
});

// A dropped binary with an unlisted extension (.webp, .heic, ...) used to
// be read as text; its NUL bytes then failed in Postgres with
// "invalid byte sequence for encoding UTF8: 0x00".
describe('FileTree — dropped files are sniffed for binary content', () => {
  const drop = (file) => ({ types: ['Files'], items: [], files: [file] });
  const root = () => screen.getByLabelText('Project files');

  it('unknown extension + NUL bytes → binary upload, not text', async () => {
    const onUploadBinary = vi.fn();
    const { props } = renderFileTree({ onUploadBinary });
    const webp = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])], 'photo.webp');
    fireEvent.drop(root(), { dataTransfer: drop(webp) });
    await vi.waitFor(() => expect(onUploadBinary).toHaveBeenCalledWith(webp, 'photo.webp'));
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('unknown extension + plain text → created as a text file', async () => {
    const onUploadBinary = vi.fn();
    const { props } = renderFileTree({ onUploadBinary });
    fireEvent.drop(root(), { dataTransfer: drop(new File(['\\newcommand{\\x}{y}'], 'macros.sty')) });
    await vi.waitFor(() => expect(props.onCreate).toHaveBeenCalledWith('macros.sty', '\\newcommand{\\x}{y}'));
    expect(onUploadBinary).not.toHaveBeenCalled();
  });
});
