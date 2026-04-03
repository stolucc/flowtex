// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import TemplateGallery from '../TemplateGallery.jsx';

afterEach(cleanup);

// Mock the api module so no real fetches happen
vi.mock('../../api.js', () => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  getCsrfToken: vi.fn(() => 'test-token'),
}));

import { get } from '../../api.js';

const MOCK_TAGS = [
  { id: 'tag-1', name: 'Academic', color: '#89b4fa' },
  { id: 'tag-2', name: 'Presentation', color: '#a6e3a1' },
];

const MOCK_TEMPLATES = [
  {
    id: 'tmpl-1',
    name: 'IEEE Conference',
    description: 'IEEE two-column template',
    category: 'Academic',
    fileCount: 3,
    preloaded: true,
    tags: [MOCK_TAGS[0]],
  },
  {
    id: 'tmpl-2',
    name: 'Beamer Slides',
    description: 'Presentation slides',
    category: 'Presentation',
    fileCount: 2,
    preloaded: false,
    author_name: 'Alice',
    tags: [MOCK_TAGS[1]],
  },
];

function setupMockApi() {
  get.mockImplementation((url) => {
    if (url.includes('template-tags')) {
      return Promise.resolve({ json: () => Promise.resolve(MOCK_TAGS) });
    }
    if (url.includes('templates')) {
      return Promise.resolve({ json: () => Promise.resolve(MOCK_TEMPLATES) });
    }
    return Promise.resolve({ json: () => Promise.resolve([]) });
  });
}

function renderGallery(overrides = {}) {
  const defaultProps = {
    onSelect: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  return { ...render(<TemplateGallery {...defaultProps} />), props: defaultProps };
}

describe('TemplateGallery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockApi();
  });

  it('renders without crashing', () => {
    renderGallery();
  });

  it('renders "New from Template" heading', () => {
    renderGallery();
    expect(screen.getByText('New from Template')).toBeTruthy();
  });

  it('renders Back to Projects button', () => {
    renderGallery();
    expect(screen.getByText('Back to Projects')).toBeTruthy();
  });

  it('calls onBack when back button is clicked', () => {
    const { props } = renderGallery();
    const backBtn = screen.getByText('Back to Projects').closest('button');
    fireEvent.click(backBtn);
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('renders Upload Template button', () => {
    renderGallery();
    expect(screen.getByText('Upload Template')).toBeTruthy();
  });

  it('renders Tags button', () => {
    renderGallery();
    expect(screen.getByText('Tags')).toBeTruthy();
  });

  it('shows loading state initially', () => {
    renderGallery();
    expect(screen.getByText('Loading templates...')).toBeTruthy();
  });

  it('shows "All" filter button', () => {
    renderGallery();
    expect(screen.getByText('All')).toBeTruthy();
  });

  it('renders template cards after loading', async () => {
    renderGallery();
    const card = await screen.findByText('IEEE Conference');
    expect(card).toBeTruthy();
    expect(screen.getByText('Beamer Slides')).toBeTruthy();
  });

  it('renders template descriptions', async () => {
    renderGallery();
    const desc = await screen.findByText('IEEE two-column template');
    expect(desc).toBeTruthy();
    expect(screen.getByText('Presentation slides')).toBeTruthy();
  });

  it('renders template file counts', async () => {
    renderGallery();
    await screen.findByText('IEEE Conference');
    expect(screen.getByText(/3 files/)).toBeTruthy();
    expect(screen.getByText(/2 files/)).toBeTruthy();
  });

  it('renders author name on non-preloaded templates', async () => {
    renderGallery();
    await screen.findByText('Beamer Slides');
    expect(screen.getByText(/by Alice/)).toBeTruthy();
  });

  it('renders tag filter buttons after loading', async () => {
    const { container } = renderGallery();
    // Tags appear both in filter buttons and on template cards, so query within the filter bar
    await waitFor(() => {
      const filterBar = container.querySelector('.template-categories');
      expect(filterBar).toBeTruthy();
      expect(filterBar.textContent).toContain('Academic');
      expect(filterBar.textContent).toContain('Presentation');
    });
  });

  it('opens upload dialog when Upload Template is clicked', () => {
    renderGallery();
    fireEvent.click(screen.getByText('Upload Template'));
    expect(screen.getByText('Upload a ZIP file containing your template files.')).toBeTruthy();
    expect(screen.getByText('Choose File')).toBeTruthy();
  });

  it('opens tag manager dialog when Tags is clicked', () => {
    renderGallery();
    fireEvent.click(screen.getByText('Tags'));
    expect(screen.getByText('Manage Tags')).toBeTruthy();
    expect(screen.getByText('Add Tag')).toBeTruthy();
  });

  it('renders delete button only on non-preloaded templates', async () => {
    const { container } = renderGallery();
    await screen.findByText('IEEE Conference');
    // Only tmpl-2 (Beamer Slides) is non-preloaded, so only one delete button
    const deleteButtons = container.querySelectorAll('.template-card-delete');
    expect(deleteButtons.length).toBe(1);
  });
});
