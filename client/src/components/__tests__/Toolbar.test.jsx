// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import Toolbar from '../Toolbar.jsx';

afterEach(cleanup);

// Mock useClickOutside — it registers document listeners that aren't needed in tests
vi.mock('../../hooks/useClickOutside.js', () => ({
  default: vi.fn(),
}));

function renderToolbar(overrides = {}) {
  const defaultProps = {
    projectName: 'Test Project',
    projectId: 'proj-1',
    onBack: vi.fn(),
    onLogout: vi.fn(),
    onShare: vi.fn(),
    onHistory: vi.fn(),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onSearch: vi.fn(),
    onInsert: vi.fn(),
    onToggleComments: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleBoxWarnings: vi.fn(),
    onCompareFiles: vi.fn(),
    onFormatDocument: vi.fn(),
    onPrettyPrint: vi.fn(),
    onGitHubSync: vi.fn(),
    onHelp: vi.fn(),
    onWordCount: vi.fn(),
    onSymbolPicker: vi.fn(),
    users: [],
    currentUser: { id: '1', name: 'Me' },
    isOwner: true,
    showComments: false,
    showChat: false,
    showBoxWarnings: false,
    showLineNumbers: true,
    wordWrap: false,
    activeFile: { path: 'main.tex' },
    ...overrides,
  };
  return { ...render(<Toolbar {...defaultProps} />), props: defaultProps };
}

describe('Toolbar', () => {
  it('renders without crashing', () => {
    renderToolbar();
  });

  it('displays the project name', () => {
    renderToolbar({ projectName: 'My LaTeX Project' });
    expect(screen.getByText('My LaTeX Project')).toBeTruthy();
  });

  it('renders the Home button', () => {
    renderToolbar();
    // Home button is icon-only now; find it by its accessible label
    // (the visual `Home` text was dropped — the icon is enough).
    expect(screen.getByRole('button', { name: /home/i })).toBeTruthy();
  });

  it('renders all menu labels', () => {
    renderToolbar();
    for (const label of ['File', 'Edit', 'Insert', 'View', 'Format', 'Tools', 'Help']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('calls onBack when Home button is clicked', () => {
    const { props } = renderToolbar();
    const homeBtn = screen.getByRole('button', { name: /home/i });
    fireEvent.click(homeBtn);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('opens the user menu and calls onLogout from its Sign out item', () => {
    const { props, container } = renderToolbar();
    const trigger = container.querySelector('.toolbar-user-menu-trigger');
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    const signOut = screen.getByRole('menuitem', { name: /sign out/i });
    fireEvent.click(signOut);
    expect(props.onLogout).toHaveBeenCalledTimes(1);
  });

  it('renders Share button and calls onShare', () => {
    const { props } = renderToolbar();
    const shareBtn = screen.getByText('Share').closest('button');
    fireEvent.click(shareBtn);
    expect(props.onShare).toHaveBeenCalledTimes(1);
  });

  it('renders History button and calls onHistory', () => {
    const { props } = renderToolbar();
    const historyBtn = screen.getByText('History').closest('button');
    fireEvent.click(historyBtn);
    expect(props.onHistory).toHaveBeenCalledTimes(1);
  });

  it('opens File menu and shows menu items on click', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('File'));
    expect(screen.getByText('New File')).toBeTruthy();
    expect(screen.getByText('New Folder')).toBeTruthy();
    expect(screen.getByText('Upload ZIP')).toBeTruthy();
    expect(screen.getByText('Download as ZIP')).toBeTruthy();
  });

  it('calls onNewFile from File menu', () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByText('File'));
    fireEvent.click(screen.getByText('New File'));
    expect(props.onNewFile).toHaveBeenCalledTimes(1);
  });

  it('opens Edit menu and shows Undo/Redo', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Undo')).toBeTruthy();
    expect(screen.getByText('Redo')).toBeTruthy();
    expect(screen.getByText('Find & Replace')).toBeTruthy();
  });

  it('calls onUndo from Edit menu', () => {
    const { props } = renderToolbar();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Undo'));
    expect(props.onUndo).toHaveBeenCalledTimes(1);
  });

  it('opens Insert menu and shows items', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('Insert'));
    expect(screen.getByText('Section')).toBeTruthy();
    expect(screen.getByText('Figure')).toBeTruthy();
    expect(screen.getByText('Table')).toBeTruthy();
  });

  it('opens View menu and shows toggles', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('View'));
    // When showComments=false, text is just "Comments Panel" (no checkmark prefix)
    expect(screen.getByText('Comments Panel')).toBeTruthy();
    expect(screen.getByText('Chat')).toBeTruthy();
  });

  it('opens Format menu', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('Format'));
    expect(screen.getByText('Bold')).toBeTruthy();
    expect(screen.getByText('Italic')).toBeTruthy();
  });

  it('opens Help menu', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('Help'));
    expect(screen.getByText('Keyboard Shortcuts')).toBeTruthy();
    expect(screen.getByText('About FlowTex')).toBeTruthy();
  });

  it('closes menu when the same menu button is clicked again', () => {
    renderToolbar();
    fireEvent.click(screen.getByText('File'));
    expect(screen.getByText('New File')).toBeTruthy();
    fireEvent.click(screen.getByText('File'));
    expect(screen.queryByText('New File')).toBeNull();
  });

  it('does not render Share button when onShare is not provided', () => {
    renderToolbar({ onShare: undefined });
    expect(screen.queryByText('Share')).toBeNull();
  });

  it('does not render History button when onHistory is not provided', () => {
    renderToolbar({ onHistory: undefined });
    expect(screen.queryByText('History')).toBeNull();
  });

  it('does not render the user menu when onLogout is not provided', () => {
    const { container } = renderToolbar({ onLogout: undefined });
    expect(container.querySelector('.toolbar-user-menu-trigger')).toBeNull();
  });
});
