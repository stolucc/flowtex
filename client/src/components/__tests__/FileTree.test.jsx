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
