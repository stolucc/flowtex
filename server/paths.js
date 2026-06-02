// Shared filesystem path constants. Lives outside compiler.js so that
// modules used by the compiler (blobStore, fileBytes) can import the
// path without creating a circular dependency back through compiler.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECTS_DIR = path.join(__dirname, '..', 'projects');
