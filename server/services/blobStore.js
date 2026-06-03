// Phase A.1 of the blob-storage migration. Pure-function module that
// owns disk-side blob persistence for one project. No DB writes here —
// upload/read routes wire blobs to the project_blobs refcount table
// themselves (lands in phase A.2).
//
// Layout (per [[project-flowtex-blob-storage]]):
//
//   server/projects/<projectId>/_blobs/<sha256[0:2]>/<sha256>
//   server/projects/<projectId>/_blobs/_tmp/<uuid>           ← in-flight uploads
//
// Two-character prefix dir keeps ext4/btrfs happy at high file counts.
// The path is entirely server-derived from the bytes' SHA-256; no
// user-controlled component goes near the filesystem path, so the
// pattern matches the safePath + sendFile({ root }) discipline we
// already use elsewhere.
//
// Per-project dedup (one project's blob dir is independent of every
// other project's). Closes the upload-timing side channel a global
// dedup would open. Storage cost is roughly the same as today's
// base64-in-DB pattern; the win is streaming + smaller backups.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { PROJECTS_DIR } from '../paths.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_HEX_RE = /^[0-9a-f-]{36}$/i;
const PROJECT_ID_RE = /^[0-9a-f-]{36}$/i; // project ids are UUIDs

/** Absolute path to a project's blob root directory. */
export function blobsDir(projectId) {
  if (!PROJECT_ID_RE.test(projectId)) {
    // Defence-in-depth: callers should only ever pass DB-sourced UUIDs.
    // Refuse anything else outright so a future caller that forwards
    // user-controlled data cannot reach the filesystem via path.join().
    throw new Error(`blobStore: invalid projectId`);
  }
  return path.join(PROJECTS_DIR, projectId, '_blobs');
}

/** Absolute path to a specific blob, derived from its sha256. */
export function blobPath(projectId, sha256) {
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`blobStore: invalid sha256 ${sha256}`);
  }
  // blobsDir() validates the projectId.
  return path.join(blobsDir(projectId), sha256.slice(0, 2), sha256);
}

/** Ensure the per-project blob root + tmp + a given two-char shard exist. */
async function ensureDirs(projectId, shardPrefix) {
  const root = blobsDir(projectId);
  await mkdir(path.join(root, '_tmp'), { recursive: true });
  await mkdir(path.join(root, shardPrefix), { recursive: true });
}

/**
 * Stream a binary upload into the blob store. Hashes during the
 * stream, writes to a uuid-named temp file, then atomically renames
 * to the final hash-derived path.
 *
 * If the blob already exists at the target path (dedup hit within
 * this project), the temp file is unlinked and the existing blob's
 * sha256 is returned. The upload is byte-identical to a prior
 * upload — we don't need two copies.
 *
 * @param {string} projectId
 * @param {Readable} stream  Source byte stream (e.g. multer file, req body).
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<{ sha256: string, size: number, deduped: boolean }>}
 */
export async function writeBlob(projectId, stream, opts = {}) {
  const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
  await ensureDirs(projectId, '00'); // sentinel; sharding dir made below if needed
  const tmpName = randomUUID();
  if (!UUID_HEX_RE.test(tmpName)) throw new Error('blobStore: invalid tmp uuid');
  const tmpPath = path.join(blobsDir(projectId), '_tmp', tmpName);

  const hash = createHash('sha256');
  let bytesSeen = 0;

  // Open the temp file with O_NOFOLLOW so a symlink planted at tmpPath
  // (via a host-level compromise or a tmp-dir race) refuses to open
  // rather than redirecting our write at an attacker-chosen path. The
  // file is then streamed through the FileHandle's WriteStream, which
  // shares the existing fd so no second open happens. Matches the
  // discipline used in compiler.syncFilesToDisk.
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const handle = await open(tmpPath, flags, 0o600);
  const out = handle.createWriteStream();
  try {
    await pipeline(
      stream,
      async function* counter(source) {
        for await (const chunk of source) {
          bytesSeen += chunk.length;
          if (bytesSeen > maxBytes) {
            const cap = `${Math.floor(maxBytes / (1024 * 1024))} MB`;
            throw Object.assign(new Error(`blobStore: file exceeds ${cap} cap`), { status: 413 });
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      out,
    );
  } catch (err) {
    // Wait for the WriteStream to release its fd before unlinking —
    // pipeline destroys the stream on error but the close is async,
    // and unlinking before the fd is released races on Windows + can
    // leave the file behind on macOS/Linux when the open() syscall
    // happens after the unlink (open-then-immediately-closed = leak).
    if (!out.closed) await new Promise((res) => out.once('close', res));
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  const sha256 = hash.digest('hex');
  const shard = sha256.slice(0, 2);
  await mkdir(path.join(blobsDir(projectId), shard), { recursive: true });
  const finalPath = blobPath(projectId, sha256);

  // Dedup check: if the blob already exists at the target path,
  // discard the temp upload and return the existing reference.
  try {
    const existing = await stat(finalPath);
    if (existing.isFile() && existing.size === bytesSeen) {
      await unlink(tmpPath).catch(() => {});
      return { sha256, size: bytesSeen, deduped: true };
    }
  } catch {
    // ENOENT — new blob, rename below.
  }

  // Atomic rename. The temp file and the final path share the same
  // filesystem (both under PROJECTS_DIR), so rename(2) is atomic.
  await rename(tmpPath, finalPath);
  return { sha256, size: bytesSeen, deduped: false };
}

/**
 * Stat a blob to confirm it exists and matches its hash-derived size.
 * Used by the read path before serving. Returns null if missing.
 */
export async function statBlob(projectId, sha256) {
  try {
    const s = await stat(blobPath(projectId, sha256));
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Open a read stream for a blob. Caller is responsible for piping
 * (or closing on error). Returns null if missing.
 */
export function readBlobStream(projectId, sha256) {
  return createReadStream(blobPath(projectId, sha256));
}

/**
 * Permanently remove a blob from disk. Called by the GC sweep after
 * ref_count drops to zero. Best-effort: missing file is treated as
 * already-deleted.
 */
export async function deleteBlob(projectId, sha256) {
  try {
    await unlink(blobPath(projectId, sha256));
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}
