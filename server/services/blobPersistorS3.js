// @ts-check
// SAAS-FOUNDATIONS item 2 -- S3-compatible blob backend.
//
// Loaded only when FLOWTEX_BLOB_BACKEND=s3 so the AWS SDK doesn't
// add 4 MB to the self-hosted install footprint.
//
// Tested target stores (the API surface used here is the lowest
// common denominator):
//   - AWS S3
//   - Cloudflare R2 (S3-compatible)
//   - Backblaze B2 (S3-compatible)
//   - MinIO (self-host, mostly for local-dev parity with prod)
//
// Required env:
//   AWS_REGION                 region (or 'auto' for R2)
//   AWS_S3_BUCKET              bucket name
//   AWS_S3_ENDPOINT            optional custom endpoint (R2 / MinIO)
//   AWS_ACCESS_KEY_ID          credential
//   AWS_SECRET_ACCESS_KEY      credential
//
// Key layout: `<projectId>/<sha256[0:2]>/<sha256>`. Mirrors the FS
// backend's sharding so a sweep over keys for one project is a
// well-bounded ListObjectsV2 with a prefix.
//
// This file is the reference implementation. To enable:
//   npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
// then set FLOWTEX_BLOB_BACKEND=s3 in env. The dynamic require below
// throws with a clear message if the SDK isn't installed, so a
// misconfiguration fails loud at boot.

import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import logger from '../logger.js';

const PROJECT_ID_RE = /^[a-z0-9-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** @param {string} projectId @param {string} sha256 */
function keyFor(projectId, sha256) {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error('blobPersistorS3: invalid projectId');
  }
  if (!SHA256_RE.test(sha256)) {
    throw new Error('blobPersistorS3: invalid sha256');
  }
  return `${projectId}/${sha256.slice(0, 2)}/${sha256}`;
}

async function loadSdk() {
  let s3;
  let upload;
  try {
    // @ts-ignore -- optional dep, present only when self-hosted operator
    // installs the AWS SDK explicitly. loadSdk throws a clear error if
    // the dynamic import fails at runtime.
    s3 = await import('@aws-sdk/client-s3');
    // @ts-ignore -- same as above; @aws-sdk/lib-storage is the multipart
    // upload helper, also optional.
    upload = await import('@aws-sdk/lib-storage');
  } catch (err) {
    throw new Error(
      'FLOWTEX_BLOB_BACKEND=s3 requires @aws-sdk/client-s3 and ' +
      '@aws-sdk/lib-storage. Install them with: ' +
      'npm install @aws-sdk/client-s3 @aws-sdk/lib-storage',
      { cause: err },
    );
  }
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_S3_BUCKET;
  const endpoint = process.env.AWS_S3_ENDPOINT;
  if (!region) throw new Error('AWS_REGION is required for FLOWTEX_BLOB_BACKEND=s3');
  if (!bucket) throw new Error('AWS_S3_BUCKET is required for FLOWTEX_BLOB_BACKEND=s3');
  const client = new s3.S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  return { s3, upload, client, bucket };
}

export async function makeS3Backend() {
  const { s3, upload, client, bucket } = await loadSdk();

  /** @param {string} projectId @param {NodeJS.ReadableStream} stream @param {{ maxBytes?: number }} [opts] */
  async function writeBlob(projectId, stream, opts = {}) {
    const maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    const hash = createHash('sha256');
    let bytesSeen = 0;

    // We need to (a) compute sha256 as we go, (b) cap at maxBytes, and
    // (c) stream to S3. lib-storage's Upload supports a streaming body,
    // so we wrap the source in a PassThrough that runs the hash and
    // cap inline.
    const passthrough = new PassThrough();
    const sizingPipe = (async () => {
      await pipeline(
        stream,
        async function* counter(source) {
          for await (const chunk of source) {
            bytesSeen += chunk.length;
            if (bytesSeen > maxBytes) {
              const cap = `${Math.floor(maxBytes / (1024 * 1024))} MB`;
              throw Object.assign(new Error(`blobPersistorS3: file exceeds ${cap} cap`), { status: 413 });
            }
            hash.update(chunk);
            yield chunk;
          }
        },
        passthrough,
      );
    })();

    // Upload to a temp key, then rename via CopyObject + Delete on
    // commit. Done so a streaming error doesn't leave a partial final
    // object visible to readers (S3 PutObject is atomic per key but
    // the final key is content-addressed -- we can't know it before
    // hashing finishes).
    const tmpKey = `${projectId}/_tmp/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const uploader = new upload.Upload({
      client,
      params: { Bucket: bucket, Key: tmpKey, Body: passthrough },
    });

    try {
      await Promise.all([sizingPipe, uploader.done()]);
    } catch (err) {
      try {
        await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: tmpKey }));
      } catch { /* tmp cleanup best-effort */ }
      throw err;
    }

    const sha256 = hash.digest('hex');
    const finalKey = keyFor(projectId, sha256);

    // Dedup: HEAD the final key first. If it exists and the size
    // matches, drop the tmp upload and return.
    try {
      const head = await client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: finalKey }));
      if (head?.ContentLength === bytesSeen) {
        await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: tmpKey }));
        return { sha256, size: bytesSeen, deduped: true };
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.name !== 'NotFound' && e?.$metadata?.httpStatusCode !== 404) throw err;
    }

    // Promote tmp -> final via server-side copy, then delete the tmp.
    await client.send(new s3.CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${tmpKey}`,
      Key: finalKey,
    }));
    await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: tmpKey }));
    return { sha256, size: bytesSeen, deduped: false };
  }

  /** @param {string} projectId @param {string} sha256 */
  async function statBlob(projectId, sha256) {
    try {
      const head = await client.send(new s3.HeadObjectCommand({
        Bucket: bucket,
        Key: keyFor(projectId, sha256),
      }));
      return {
        size: head?.ContentLength ?? 0,
        mtimeMs: head?.LastModified?.getTime?.() ?? 0,
      };
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  /** @param {string} projectId @param {string} sha256 */
  async function readBlobStream(projectId, sha256) {
    const out = await client.send(new s3.GetObjectCommand({
      Bucket: bucket,
      Key: keyFor(projectId, sha256),
    }));
    return out?.Body ?? null;
  }

  /** @param {string} projectId @param {string} sha256 */
  async function deleteBlob(projectId, sha256) {
    try {
      await client.send(new s3.DeleteObjectCommand({
        Bucket: bucket,
        Key: keyFor(projectId, sha256),
      }));
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.$metadata?.httpStatusCode === 404) return;
      throw err;
    }
  }

  logger.info({ bucket, region: process.env.AWS_REGION }, 'blob persistor: S3 backend ready');

  return {
    name: 's3',
    info: () => ({ backend: 's3', bucket, region: process.env.AWS_REGION, endpoint: process.env.AWS_S3_ENDPOINT || null }),
    writeBlob,
    statBlob,
    readBlobStream,
    deleteBlob,
  };
}
