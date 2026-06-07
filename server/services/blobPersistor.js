// SAAS-FOUNDATIONS item 2 -- pluggable blob storage backend.
//
// FlowTex's existing `blobStore.js` writes content-addressed blobs to
// per-project on-disk paths. That's fine for single-instance deploys;
// it doesn't work the moment two web instances need to share blobs
// (item 6 -- stateless web tier).
//
// This module gives callers a single interface and selects the
// backend at boot from `FLOWTEX_BLOB_BACKEND` (default `fs`). The
// existing `blobStore.js` becomes the FS backend; an S3-compatible
// backend (R2 / MinIO / AWS S3) lives in `blobPersistorS3.js` and is
// dynamically imported when selected so the AWS SDK doesn't load
// for self-hosted deploys that don't need it.
//
// All backends implement the same four-method shape:
//
//   writeBlob(projectId, stream, opts)  -> { sha256, size, deduped }
//   statBlob(projectId, sha256)         -> { size, mtimeMs } | null
//   readBlobStream(projectId, sha256)   -> Readable
//   deleteBlob(projectId, sha256)       -> Promise<void>
//
// Plus an optional `info()` for the boot log.

import logger from '../logger.js';
import * as fsBackend from './blobStore.js';

let activeBackend = null;
let activeName = null;

const BACKENDS = {
  fs: () => Promise.resolve(makeFsBackend()),
  s3: () => import('./blobPersistorS3.js').then((m) => m.makeS3Backend()),
};

function makeFsBackend() {
  return {
    name: 'fs',
    info: () => ({ backend: 'fs', root: 'server/projects/<id>/_blobs/' }),
    writeBlob: fsBackend.writeBlob,
    statBlob: fsBackend.statBlob,
    readBlobStream: fsBackend.readBlobStream,
    deleteBlob: fsBackend.deleteBlob,
  };
}

/**
 * Select and load the configured backend. Idempotent: a second call
 * returns the already-loaded one (matching the lazy-singleton shape
 * the existing yjsRoom service uses).
 */
export async function getBlobPersistor() {
  if (activeBackend) return activeBackend;
  const requested = (process.env.FLOWTEX_BLOB_BACKEND || 'fs').toLowerCase();
  const loader = BACKENDS[requested];
  if (!loader) {
    throw new Error(
      `FLOWTEX_BLOB_BACKEND="${requested}" is not a recognised backend. ` +
      `Valid values: ${Object.keys(BACKENDS).join(', ')}.`,
    );
  }
  try {
    activeBackend = await loader();
    activeName = requested;
    logger.info({ ...activeBackend.info?.() }, 'blob persistor initialised');
    return activeBackend;
  } catch (err) {
    logger.error({ err, requested }, 'blob persistor load failed');
    throw err;
  }
}

/** For tests + reinit. */
export function _resetBlobPersistor() {
  activeBackend = null;
  activeName = null;
}

/** Returns the active backend's short name (or null before init). */
export function getActiveBackendName() {
  return activeName;
}

// ── Pass-through convenience exports ───────────────────────────────────
//
// Callers that already use the FS-backed `blobStore` symbols don't have
// to thread `getBlobPersistor()` through every call site. These
// wrappers select the active backend lazily. The original `blobStore`
// exports remain (for now) so the rest of the codebase compiles
// without a sweeping rename; phase 2.5 will migrate call sites to use
// these accessors.

export async function writeBlob(projectId, stream, opts) {
  const b = await getBlobPersistor();
  return b.writeBlob(projectId, stream, opts);
}
export async function statBlob(projectId, sha256) {
  const b = await getBlobPersistor();
  return b.statBlob(projectId, sha256);
}
export async function readBlobStream(projectId, sha256) {
  const b = await getBlobPersistor();
  return b.readBlobStream(projectId, sha256);
}
export async function deleteBlob(projectId, sha256) {
  const b = await getBlobPersistor();
  return b.deleteBlob(projectId, sha256);
}
