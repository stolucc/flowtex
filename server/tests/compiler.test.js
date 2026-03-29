import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';

// Test the safePath logic directly (re-implemented here since it's not exported)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(__dirname, '..', '..', 'projects');

function safePath(projectDir, filePath) {
  if (filePath.includes('\0') || path.isAbsolute(filePath)) {
    throw new Error(`Invalid file path: ${filePath}`);
  }
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

describe('safePath', () => {
  const projectDir = path.join(PROJECTS_DIR, 'test-project');

  it('accepts a simple filename', () => {
    expect(safePath(projectDir, 'main.tex')).toBe(path.join(projectDir, 'main.tex'));
  });

  it('accepts nested paths', () => {
    expect(safePath(projectDir, 'chapters/intro.tex')).toBe(
      path.join(projectDir, 'chapters', 'intro.tex')
    );
  });

  it('rejects path traversal with ..', () => {
    expect(() => safePath(projectDir, '../../../etc/passwd')).toThrow('Path traversal');
  });

  it('rejects absolute paths', () => {
    expect(() => safePath(projectDir, '/etc/passwd')).toThrow('Invalid file path');
  });

  it('rejects null bytes', () => {
    expect(() => safePath(projectDir, 'main.tex\0.pdf')).toThrow('Invalid file path');
  });

  it('rejects sneaky traversal like foo/../../..', () => {
    expect(() => safePath(projectDir, 'foo/../../../etc/passwd')).toThrow('Path traversal');
  });
});
