// @ts-check
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
//
// SAAS-FOUNDATIONS item 2 phase 2.5: optional 404-fallback chain.
// When FLOWTEX_BLOB_FALLBACK_BACKEND is set, read paths (statBlob,
// readBlobStream) consult the fallback when the primary returns
// null. Write paths (writeBlob, deleteBlob) only ever target the
// primary. This is the migration mode -- during an FS -> S3
// rollout, set primary=s3, fallback=fs; new writes land on S3, old
// reads still resolve from the FS tree until a separate migrator
// has moved them over.

import { Buffer } from 'node:buffer';
import logger from '../logger.js';
import * as fsBackend from './blobStore.js';
import { withSpan } from '../tracing.js';

// Short sha helper for span attributes -- carry enough to grep the
// trace back to a specific blob without leaking the full 64-char
// hash into trace UIs that truncate badly.
/** @param {string | undefined | null} sha */
function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 8) : 'unknown';
}

/**
 * @typedef {{
 *   name: string,
 *   info?: () => object,
 *   writeBlob: (projectId: string, stream: import('node:stream').Readable, opts?: { maxBytes?: number }) => Promise<{ sha256: string, size: number, deduped: boolean }>,
 *   statBlob: (projectId: string, sha256: string) => Promise<{ size: number, mtimeMs: number } | null>,
 *   readBlobStream: (projectId: string, sha256: string) =>
 *     import('node:stream').Readable | null | Promise<import('node:stream').Readable | null>,
 *   deleteBlob: (projectId: string, sha256: string) => Promise<void>,
 * }} BlobBackend
 */

/** @type {BlobBackend | null} */
let activeBackend = null;
/** @type {string | null} */
let activeName = null;
/** @type {BlobBackend | null} */
let fallbackBackend = null;
/** @type {string | null} */
let fallbackName = null;

/** @type {Record<string, () => Promise<BlobBackend>>} */
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

/** @param {string} name */
async function loadBackend(name) {
  const loader = BACKENDS[name];
  if (!loader) {
    throw new Error(
      `FLOWTEX_BLOB_BACKEND="${name}" is not a recognised backend. ` +
      `Valid values: ${Object.keys(BACKENDS).join(', ')}.`,
    );
  }
  return loader();
}

/**
 * Select and load the configured backend. Idempotent: a second call
 * returns the already-loaded one (matching the lazy-singleton shape
 * the existing yjsRoom service uses).
 */
export async function getBlobPersistor() {
  if (activeBackend) return activeBackend;
  const requestedPrimary = (process.env.FLOWTEX_BLOB_BACKEND || 'fs').toLowerCase();
  const requestedFallback = (process.env.FLOWTEX_BLOB_FALLBACK_BACKEND || '').toLowerCase();
  try {
    activeBackend = await loadBackend(requestedPrimary);
    activeName = requestedPrimary;
    if (requestedFallback) {
      if (requestedFallback === requestedPrimary) {
        // Fallback to the same backend would be pointless; reject so
        // a misconfig is loud rather than a silent perf cost on every
        // read.
        throw new Error('FLOWTEX_BLOB_FALLBACK_BACKEND must differ from FLOWTEX_BLOB_BACKEND');
      }
      fallbackBackend = await loadBackend(requestedFallback);
      fallbackName = requestedFallback;
    }
    logger.info(
      {
        ...activeBackend.info?.(),
        fallback: fallbackBackend?.info?.() ?? null,
      },
      'blob persistor initialised',
    );
    return activeBackend;
  } catch (err) {
    logger.error({ err, requestedPrimary, requestedFallback }, 'blob persistor load failed');
    throw err;
  }
}

/** For tests + reinit. */
export function _resetBlobPersistor() {
  activeBackend = null;
  activeName = null;
  fallbackBackend = null;
  fallbackName = null;
}

/** Returns the active backend's short name (or null before init). */
export function getActiveBackendName() {
  return activeName;
}

/** Returns the fallback backend's short name (or null when none). */
export function getFallbackBackendName() {
  return fallbackName;
}

// ── Pass-through convenience exports ───────────────────────────────────

/**
 * @param {string} projectId
 * @param {import('node:stream').Readable} stream
 * @param {{ maxBytes?: number }} [opts]
 */
export async function writeBlob(projectId, stream, opts) {
  return withSpan('blob.writeBlob', async (span) => {
    const b = await getBlobPersistor();
    span.setAttribute('flowtex.project_id', projectId);
    span.setAttribute('flowtex.backend', getActiveBackendName() || 'unknown');
    // Writes only ever go to the primary backend. The fallback exists
    // for read-side migration, not as a write target.
    const result = await b.writeBlob(projectId, stream, opts);
    if (result?.sha256) span.setAttribute('flowtex.sha256', shortSha(result.sha256));
    if (typeof result?.size === 'number') span.setAttribute('flowtex.blob_bytes', result.size);
    if (typeof result?.deduped === 'boolean') span.setAttribute('flowtex.deduped', result.deduped);
    return result;
  });
}

/**
 * Stat a blob. Tries the primary backend first; on null result, falls
 * back to the secondary backend if one was configured. Returns null
 * iff neither backend has the blob.
 */
/**
 * @param {string} projectId
 * @param {string} sha256
 */
export async function statBlob(projectId, sha256) {
  return withSpan('blob.statBlob', async (span) => {
    span.setAttribute('flowtex.project_id', projectId);
    span.setAttribute('flowtex.sha256', shortSha(sha256));
    span.setAttribute('flowtex.backend', getActiveBackendName() || 'unknown');
    const b = await getBlobPersistor();
    const primary = await b.statBlob(projectId, sha256);
    if (primary) {
      span.setAttribute('flowtex.fell_back', false);
      return primary;
    }
    if (fallbackBackend) {
      try {
        const fb = await fallbackBackend.statBlob(projectId, sha256);
        if (fb) {
          span.setAttribute('flowtex.fell_back', true);
          span.setAttribute('flowtex.fallback_backend', getFallbackBackendName() || 'unknown');
          return fb;
        }
      } catch (err) {
        logger.warn({ err, projectId, sha256 }, 'blob fallback statBlob failed');
        span.recordException(err);
      }
    }
    span.setAttribute('flowtex.found', false);
    return null;
  });
}

/**
 * Open a read stream for a blob. Tries the primary backend first;
 * on null (missing) result, falls back to the secondary backend.
 *
 * NOTE: the primary backend's readBlobStream may return a stream that
 * errors on `open` rather than returning null synchronously (the FS
 * implementation does this -- createReadStream returns a stream that
 * emits 'error' with code ENOENT on first read). To make the fallback
 * work in that case, we statBlob the primary first; if missing, we
 * fall back directly. This adds one stat call per read but is the
 * only correct semantics for "is this blob on this backend?".
 */
/**
 * @param {string} projectId
 * @param {string} sha256
 */
export async function readBlobStream(projectId, sha256) {
  return withSpan('blob.readBlobStream', async (span) => {
    span.setAttribute('flowtex.project_id', projectId);
    span.setAttribute('flowtex.sha256', shortSha(sha256));
    span.setAttribute('flowtex.backend', getActiveBackendName() || 'unknown');
    const b = await getBlobPersistor();
    if (fallbackBackend) {
      // Two-backend path: must stat first to choose which to read from,
      // because a streaming open may not surface ENOENT until first
      // read.
      const primary = await b.statBlob(projectId, sha256);
      if (primary) {
        span.setAttribute('flowtex.fell_back', false);
        return b.readBlobStream(projectId, sha256);
      }
      const fb = await fallbackBackend.statBlob(projectId, sha256);
      if (fb) {
        span.setAttribute('flowtex.fell_back', true);
        span.setAttribute('flowtex.fallback_backend', getFallbackBackendName() || 'unknown');
        return fallbackBackend.readBlobStream(projectId, sha256);
      }
      span.setAttribute('flowtex.found', false);
      return null;
    }
    // Single-backend path: defer to the backend's own stream, which
    // matches the legacy createReadStream behaviour callers already
    // expect.
    return b.readBlobStream(projectId, sha256);
  });
}

/**
 * @param {string} projectId
 * @param {string} sha256
 */
export async function deleteBlob(projectId, sha256) {
  return withSpan('blob.deleteBlob', async (span) => {
    span.setAttribute('flowtex.project_id', projectId);
    span.setAttribute('flowtex.sha256', shortSha(sha256));
    span.setAttribute('flowtex.backend', getActiveBackendName() || 'unknown');
    const b = await getBlobPersistor();
    // Delete only the primary copy. During an FS -> S3 rollout, the
    // separate migrator owns moving blobs over and deleting old ones;
    // the runtime ref-count path here must NOT silently destroy a copy
    // the migrator hasn't promoted yet.
    return b.deleteBlob(projectId, sha256);
  });
}

/**
 * Backend-agnostic "give me the bytes" convenience. Streams the blob
 * into a Buffer. Returns null if the blob is missing across primary +
 * fallback. Callers that want streaming should use readBlobStream
 * directly; this exists for the legacy `await readFile(blobPath(...))`
 * pattern.
 */
/**
 * @param {string} projectId
 * @param {string} sha256
 * @returns {Promise<Buffer | null>}
 */
export async function loadBlobBytes(projectId, sha256) {
  return withSpan('blob.loadBlobBytes', async (span) => {
    span.setAttribute('flowtex.project_id', projectId);
    span.setAttribute('flowtex.sha256', shortSha(sha256));
    // The inner readBlobStream span is a child of this one (active-
    // context propagation handles that automatically), so the trace
    // shows: loadBlobBytes -> readBlobStream -> auto-instrumented FS
    // or S3 child as nested spans.
    const stream = await readBlobStream(projectId, sha256);
    if (!stream) {
      span.setAttribute('flowtex.found', false);
      return null;
    }
    // FS-backend createReadStream returns a stream that may ENOENT on
    // first read rather than the readBlobStream call itself, so handle
    // that as a missing-blob signal too.
    return new Promise(
      /** @param {(value: Buffer | null) => void} resolve
       *  @param {(err: unknown) => void} reject */
      (resolve, reject) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let total = 0;
        stream.on('data', (/** @type {Buffer} */ chunk) => {
          chunks.push(chunk);
          total += chunk.length;
        });
        stream.on('end', () => {
          span.setAttribute('flowtex.blob_bytes', total);
          resolve(Buffer.concat(chunks));
        });
        stream.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
          if (err?.code === 'ENOENT') {
            span.setAttribute('flowtex.found', false);
            resolve(null);
          } else {
            span.recordException(err);
            reject(err);
          }
        });
    });
  });
}
