// DOCX import fuzz harness. Feed malformed .docx files at the importer and
// assert each gets a structured error (SSE 'error' event or 4xx) without
// crashing the server, hanging the request, or 500'ing.
//
// Corpus generated programmatically using JSZip (we only need ZIP create —
// adm-zip is at the server). For ZIP creation in tests, we hand-roll the
// minimal STORED-method ZIP format ourselves since adding another dep just
// for this is overkill.
import { test, expect } from 'playwright/test';
import zlib from 'node:zlib';
import { seedUser, cleanup, close } from './_seed.js';

const BASE = process.env.E2E_BASE_URL || 'https://localhost:3001';

let user;

test.beforeAll(async () => {
  user = await seedUser('e2e-docx-fuzz@test.local', 'DOCX Fuzz');
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
});
test.afterAll(async () => {
  await cleanup(['e2e-docx-fuzz@test.local']);
  await close();
});

// ── Hand-rolled minimal ZIP builder ──
// Produces a valid PKZIP archive with each entry STORED (no compression).
// Buffers only — no streams. Good enough for fuzz inputs of <50MB.
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(dataBuf) : crc32(dataBuf);
    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // method (STORED)
    lfh.writeUInt16LE(0, 10); // mtime
    lfh.writeUInt16LE(0, 12); // mdate
    lfh.writeUInt32LE(crc, 14); // crc
    lfh.writeUInt32LE(dataBuf.length, 18); // compressed size
    lfh.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26); // name length
    lfh.writeUInt16LE(0, 28); // extra length
    chunks.push(lfh, nameBuf, dataBuf);

    // Central directory entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); // version made/needed
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20); cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, nameBuf);
    offset += lfh.length + nameBuf.length + dataBuf.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, eocd]);
}

// CRC32 fallback for older Node — node 22+ has zlib.crc32, but be safe.
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Corpus ──
// Each entry is { name, body: Buffer, label }. The fuzz test posts each as
// an upload and asserts the server responds with a structured error and
// stays alive.
function corpus() {
  return [
    { label: 'empty file', body: Buffer.alloc(0) },
    { label: 'random non-zip bytes', body: Buffer.from('this is not a zip file at all'.repeat(100)) },
    { label: 'truncated zip header', body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]) },
    {
      label: 'valid zip but no document.xml',
      body: makeZip([{ name: 'random.txt', data: 'hello' }]),
    },
    {
      label: 'document.xml with malformed XML',
      body: makeZip([{ name: 'word/document.xml', data: '<<<not valid xml >>>' }]),
    },
    {
      label: 'document.xml with valid XML but wrong namespace',
      body: makeZip([{ name: 'word/document.xml', data: '<?xml version="1.0"?><totally><not>OOXML</not></totally>' }]),
    },
    {
      label: 'document.xml exceeds 30MB cap',
      body: makeZip([{ name: 'word/document.xml', data: Buffer.from('x'.repeat(31 * 1024 * 1024)) }]),
    },
    {
      label: 'zip entry with path traversal in name',
      body: makeZip([
        { name: '../../../../etc/passwd', data: 'pwned' },
        { name: 'word/document.xml', data: '<?xml version="1.0"?><w:document xmlns:w="x"></w:document>' },
      ]),
    },
    {
      label: 'billion-laughs in document.xml',
      body: makeZip([{
        name: 'word/document.xml',
        data: '<?xml version="1.0"?><!DOCTYPE root [' +
          '<!ENTITY a "AAAAAAAAAA">' +
          '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
          '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">' +
          ']><root>&c;</root>',
      }]),
    },
    {
      label: 'deeply nested XML',
      body: makeZip([{
        name: 'word/document.xml',
        data: '<?xml version="1.0"?>' + '<w:p>'.repeat(5000) + 'x' + '</w:p>'.repeat(5000),
      }]),
    },
  ];
}

async function postDocx(bytes) {
  // Multipart upload via FormData.
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'fuzz.docx');
  const r = await fetch(`${BASE}/api/projects/from-docx`, {
    method: 'POST',
    headers: { Cookie: `__session=${user.cookieValue}`, Origin: BASE, 'X-CSRF-Token': user.csrfToken },
    body: fd,
  });
  return r;
}

async function readSSE(response, timeoutMs = 10_000) {
  // The endpoint returns SSE; we drain the stream until 'error' or 'result'
  // event lands or the connection closes.
  if (!response.body) return { events: [] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined, done: true }), Math.max(0, deadline - Date.now()))),
    ]);
    if (done) break;
    if (value) {
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try { events.push(JSON.parse(line.slice(5).trim())); }
        catch { events.push({ raw: line }); }
      }
      // Stop reading after we see a terminal event (the server sends
      // `{ type: 'error', error: ... }` on failure, `{ type: 'result', ... }` on success).
      if (events.some((e) => e.type === 'error' || e.type === 'result')) break;
    }
  }
  try { reader.cancel(); } catch {}
  return { events };
}

test('DOCX fuzz: malformed inputs are handled without crashing the server', async () => {
  test.setTimeout(180_000);
  const inputs = corpus();
  const failures = [];

  for (const { label, body } of inputs) {
    let result;
    try {
      const r = await postDocx(body);
      // 4xx (rejected outright) is fine, 200 with SSE 'error' event is fine.
      // 500 with no useful body is bad. Hang is bad.
      if (r.status >= 500) {
        failures.push(`[${label}] HTTP ${r.status}`);
        continue;
      }
      if (r.status >= 400) {
        result = { ok: 'rejected at ' + r.status };
      } else {
        const sse = await readSSE(r, 10_000);
        const hasError = sse.events.some((e) => e.type === 'error');
        const hasResult = sse.events.some((e) => e.type === 'result');
        if (!hasError && !hasResult) {
          // No terminal event within timeout — the server hung or never
          // emitted a structured error. That's a failure mode.
          failures.push(`[${label}] no terminal SSE event in 10s (events=${sse.events.length})`);
        } else {
          result = { ok: hasResult ? 'imported' : 'errored cleanly' };
        }
      }
    } catch (err) {
      failures.push(`[${label}] threw: ${err.message}`);
    }
    if (result) console.log(`  ✓ ${label}: ${result.ok}`);
  }

  // Confirm the server is still alive afterwards.
  const health = await fetch(`${BASE}/api/health`);
  expect(health.ok, 'server died during fuzz run').toBe(true);

  if (failures.length > 0) {
    console.log('\nFailures:\n  ' + failures.join('\n  '));
  }
  expect(failures, `${failures.length} fuzz inputs caused crash/hang`).toEqual([]);
});
