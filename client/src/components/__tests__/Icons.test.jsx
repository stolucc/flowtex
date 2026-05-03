// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  SearchIcon,
  FileDocumentIcon,
  FolderIcon,
  UndoIcon,
  RedoIcon,
  ZoomOutIcon,
  ZoomInIcon,
  ContrastIcon,
  DropdownCaretIcon,
  TrashIcon,
  DownloadIcon,
  HomeIcon,
  UploadIcon,
  LogoutIcon,
  TagIcon,
} from '../Icons.jsx';

const ALL_ICONS = [
  { Component: ChevronLeftIcon, name: 'ChevronLeftIcon', defaultSize: 14 },
  { Component: ChevronRightIcon, name: 'ChevronRightIcon', defaultSize: 12 },
  { Component: CloseIcon, name: 'CloseIcon', defaultSize: 14 },
  { Component: SearchIcon, name: 'SearchIcon', defaultSize: 14 },
  { Component: FileDocumentIcon, name: 'FileDocumentIcon', defaultSize: 12 },
  { Component: FolderIcon, name: 'FolderIcon', defaultSize: 18 },
  { Component: UndoIcon, name: 'UndoIcon', defaultSize: 14 },
  { Component: RedoIcon, name: 'RedoIcon', defaultSize: 14 },
  { Component: ZoomOutIcon, name: 'ZoomOutIcon', defaultSize: 14 },
  { Component: ZoomInIcon, name: 'ZoomInIcon', defaultSize: 14 },
  { Component: ContrastIcon, name: 'ContrastIcon', defaultSize: 14 },
  { Component: DropdownCaretIcon, name: 'DropdownCaretIcon', defaultSize: 8 },
  { Component: TrashIcon, name: 'TrashIcon', defaultSize: 14 },
  { Component: DownloadIcon, name: 'DownloadIcon', defaultSize: 14 },
  { Component: HomeIcon, name: 'HomeIcon', defaultSize: 16 },
  { Component: UploadIcon, name: 'UploadIcon', defaultSize: 14 },
  { Component: LogoutIcon, name: 'LogoutIcon', defaultSize: 16 },
  { Component: TagIcon, name: 'TagIcon', defaultSize: 14 },
];

describe('Icons', () => {
  ALL_ICONS.forEach(({ Component, name, defaultSize }) => {
    describe(name, () => {
      it('renders an SVG element', () => {
        const { container } = render(<Component />);
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
      });

      it(`has default size of ${defaultSize}`, () => {
        const { container } = render(<Component />);
        const svg = container.querySelector('svg');
        expect(svg.getAttribute('width')).toBe(String(defaultSize));
        expect(svg.getAttribute('height')).toBe(String(defaultSize));
      });

      it('accepts a custom size prop', () => {
        const { container } = render(<Component size={32} />);
        const svg = container.querySelector('svg');
        expect(svg.getAttribute('width')).toBe('32');
        expect(svg.getAttribute('height')).toBe('32');
      });

      it('passes through className', () => {
        const { container } = render(<Component className="test-class" />);
        const svg = container.querySelector('svg');
        expect(svg.classList.contains('test-class')).toBe(true);
      });

      it('passes through onClick handler', () => {
        const onClick = vi.fn();
        const { container } = render(<Component onClick={onClick} />);
        const svg = container.querySelector('svg');
        fireEvent.click(svg);
        expect(onClick).toHaveBeenCalledTimes(1);
      });
    });
  });
});
