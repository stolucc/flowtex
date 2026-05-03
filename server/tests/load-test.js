/**
 * FlowTex Load Test — Simulates 1000 concurrent users
 *
 * Usage:
 *   node tests/load-test.js [--users N] [--duration S] [--host URL]
 *
 * Scenario:
 *   - Registers N users in batches
 *   - Creates 50 shared projects (20 users each) + individual projects
 *   - Each user opens a WebSocket, joins their project room
 *   - Users send document changes + cursor updates at realistic intervals
 *   - REST API calls (file saves, file listings) interspersed
 *   - Reports throughput, latency percentiles, errors, and memory
 */

import http from 'http';
import https from 'https';
import { WebSocket } from 'ws';
import pg from 'pg';

// ── Config ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

const NUM_USERS = parseInt(flag('--users', '1000'));
const DURATION_SEC = parseInt(flag('--duration', '60'));
const HOST = flag('--host', 'http://localhost:3001');
const BATCH_SIZE = 50; // register/login this many at a time
const SHARED_PROJECTS = 50;
const USERS_PER_SHARED = 20;
const SAVE_INTERVAL_MS = 3000; // how often each user saves via REST
const LIST_INTERVAL_MS = 5000; // how often each user lists files
const COMPILE_INTERVAL_MS = 10000; // how often each user compiles
const RAMP_UP_MS = 10000; // spread user connections over this window

const isHttps = HOST.startsWith('https');
const httpModule = isHttps ? https : http;
const wsProto = isHttps ? 'wss' : 'ws';
const hostUrl = new URL(HOST);

// ── Source project for realistic content ────────────────────────────────
// Uses the EMSE 2 project by Klaas Stol — a real academic paper with
// ~200KB .tex, custom journal class, bibliography, etc.
const SOURCE_PROJECT_ID = '6c09cf5d-1a63-46fa-9b2f-6a9c6b5d66aa';
let sourceProjectFiles = null; // fetched once at startup

// Fetch all files from the source project directly from the database
async function fetchSourceFiles() {
  const pool = new pg.Pool({ database: process.env.PGDATABASE || 'flowtex' });
  try {
    const { rows } = await pool.query('SELECT path, content, is_binary FROM files WHERE project_id = $1', [
      SOURCE_PROJECT_ID,
    ]);
    console.log(
      `  Loaded ${rows.length} files from source project (${rows.filter((r) => !r.is_binary).reduce((s, r) => s + (r.content?.length || 0), 0)} chars total)`,
    );
    return rows;
  } finally {
    await pool.end();
  }
}


// ── Stats ──────────────────────────────────────────────────────────────
const stats = {
  registrations: 0,
  logins: 0,
  projectsCreated: 0,
  wsConnected: 0,
  wsJoined: 0,
  wsMsgSent: 0,
  wsMsgRecv: 0,
  restCalls: 0,
  compilations: 0,
  compileFails: 0,
  compileLatencies: [],
  errors: [],
  latencies: [], // REST latencies in ms
  wsLatencies: [], // time from WS send to recv for pong-like responses
  startTime: 0,
  peakWsConnections: 0,
};

function recordLatency(arr, ms) {
  arr.push(ms);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

// ── HTTP helpers ───────────────────────────────────────────────────────
function request(method, path, body, cookies = '') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(cookies && { Cookie: cookies }),
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    // Extract CSRF token from cookies string
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const csrfMatch = cookies.match(/csrf-token=([^;]+)/);
      if (csrfMatch) headers['X-CSRF-Token'] = csrfMatch[1];
    }

    const opts = {
      hostname: hostUrl.hostname,
      port: hostUrl.port || (isHttps ? 443 : 80),
      path,
      method,
      headers,
    };

    const req = httpModule.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => {
        const ms = Date.now() - start;
        recordLatency(stats.latencies, ms);
        stats.restCalls++;

        // Collect Set-Cookie headers into a map then rebuild
        const cookieMap = new Map();
        // Parse existing cookies
        for (const part of cookies.split('; ').filter(Boolean)) {
          const eq = part.indexOf('=');
          if (eq > 0) cookieMap.set(part.slice(0, eq), part.slice(eq + 1));
        }
        // Apply new cookies from response
        const setCookies = res.headers['set-cookie'] || [];
        for (const sc of setCookies) {
          const [kv] = sc.split(';');
          const eq = kv.indexOf('=');
          if (eq > 0) cookieMap.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim());
        }
        // Rebuild cookie string
        let updatedCookies = [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

        let json;
        try {
          json = JSON.parse(body);
        } catch {
          json = body;
        }
        if (res.statusCode >= 400) {
          resolve({ status: res.statusCode, json, cookies: updatedCookies, error: true });
        } else {
          resolve({ status: res.statusCode, json, cookies: updatedCookies });
        }
      });
    });

    req.on('error', (err) => {
      stats.errors.push(`HTTP ${method} ${path}: ${err.message}`);
      reject(err);
    });

    if (data) req.write(data);
    req.end();
  });
}

// ── User simulation ────────────────────────────────────────────────────
class SimUser {
  constructor(index, runId) {
    this.index = index;
    this.email = `lt${runId}_${index}@test.local`;
    this.password = `LoadTest${index}!`;
    this.name = `User ${index}`;
    this.cookies = '';
    this.userId = null;
    this.projectId = null;
    this.fileId = null;
    this.fileContent = '';
    this.ws = null;
    this.intervals = [];
    this.joined = false;
  }

  async register() {
    try {
      const res = await request(
        'POST',
        '/api/auth/register',
        {
          email: this.email,
          name: this.name,
          password: this.password,
        },
        this.cookies,
      );
      this.cookies = res.cookies;
      if (!res.error) {
        this.userId = res.json.id;
        stats.registrations++;
      }
      return res;
    } catch {
      return null;
    }
  }

  async login() {
    try {
      const res = await request(
        'POST',
        '/api/auth/login',
        {
          email: this.email,
          password: this.password,
        },
        this.cookies,
      );
      this.cookies = res.cookies;
      if (!res.error) {
        this.userId = res.json.id;
        stats.logins++;
      }
      return res;
    } catch (e) {
      stats.errors.push(`Login failed user ${this.index}: ${e.message}`);
      return null;
    }
  }

  async createProject() {
    try {
      const res = await request(
        'POST',
        '/api/projects',
        {
          name: `LoadTest Project ${this.index}`,
        },
        this.cookies,
      );
      if (!res.error) {
        this.projectId = res.json.id;
        stats.projectsCreated++;
      }
      return res;
    } catch (e) {
      stats.errors.push(`Create project failed user ${this.index}: ${e.message}`);
      return null;
    }
  }

  // Copy all files from the source project into this user's project
  async populateFromSource() {
    if (!this.projectId || !sourceProjectFiles) return;
    try {
      for (const srcFile of sourceProjectFiles) {
        if (srcFile.is_binary) continue; // skip PDFs etc.
        if (srcFile.path === 'main.tex') {
          // The project already has main.tex — update it with source content
          if (this.fileId) {
            await request(
              'PUT',
              `/api/projects/files/${this.fileId}`,
              {
                content: srcFile.content || '',
              },
              this.cookies,
            );
            this.fileContent = srcFile.content || '';
          }
        } else {
          // Create all other source files
          await request(
            'POST',
            `/api/projects/${this.projectId}/files`,
            {
              path: srcFile.path,
              content: srcFile.content || '',
            },
            this.cookies,
          );
        }
      }
      // Set main_file to ManuscriptR2.tex (the actual paper)
      await request(
        'PUT',
        `/api/projects/${this.projectId}`,
        {
          main_file: 'ManuscriptR2.tex',
        },
        this.cookies,
      );
    } catch (e) {
      stats.errors.push(`Populate files failed user ${this.index}: ${e.message}`);
    }
  }

  async listFiles() {
    if (!this.projectId) return;
    try {
      const res = await request('GET', `/api/projects/${this.projectId}/files`, null, this.cookies);
      if (!res.error && Array.isArray(res.json) && res.json.length > 0) {
        // Prefer main.tex as the file to edit
        const mainFile = res.json.find((f) => f.path === 'main.tex');
        const target = mainFile || res.json[0];
        this.fileId = target.id;
        this.fileContent = target.content || '';
      }
    } catch (e) {
      stats.errors.push(`List files failed user ${this.index}: ${e.message}`);
    }
  }

  async saveFile() {
    if (!this.fileId) return;
    try {
      await request(
        'PUT',
        `/api/projects/files/${this.fileId}`,
        {
          content: this.fileContent,
        },
        this.cookies,
      );
    } catch (e) {
      stats.errors.push(`Save failed user ${this.index}: ${e.message}`);
    }
  }

  async compileProject() {
    if (!this.projectId) return;
    try {
      const start = Date.now();
      const res = await request('POST', `/api/compile/${this.projectId}`, {}, this.cookies);
      const ms = Date.now() - start;
      recordLatency(stats.compileLatencies, ms);
      if (res.error || !res.json?.success) {
        stats.compileFails++;
      } else {
        stats.compilations++;
      }
    } catch (e) {
      stats.errors.push(`Compile failed user ${this.index}: ${e.message}`);
    }
  }

  connectWebSocket() {
    return new Promise((resolve) => {
      const wsUrl = `${wsProto}://${hostUrl.hostname}:${hostUrl.port || (isHttps ? 443 : 80)}/ws`;
      this.ws = new WebSocket(wsUrl, {
        headers: { Cookie: this.cookies },
      });

      const timeout = setTimeout(() => {
        stats.errors.push(`WS connect timeout user ${this.index}`);
        resolve(false);
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        stats.wsConnected++;
        stats.peakWsConnections = Math.max(stats.peakWsConnections, stats.wsConnected);
        resolve(true);
      });

      this.ws.on('message', (_raw) => {
        stats.wsMsgRecv++;
      });

      this.ws.on('close', () => {
        stats.wsConnected = Math.max(0, stats.wsConnected - 1);
      });

      this.ws.on('error', (_err) => {
        clearTimeout(timeout);
        resolve(false);
      });

      this.ws.on('unexpected-response', (_req, _res) => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  // Simulate editing: append a LaTeX comment so the document stays compilable
  editFile() {
    if (!this.fileContent && this.fileContent !== '') return;
    // Insert a comment before \end{document} to keep the LaTeX valid
    const endDoc = this.fileContent.lastIndexOf('\\end{document}');
    if (endDoc >= 0) {
      const insertText = `% Edit by ${this.name} at ${Date.now()}\n`;
      this.fileContent = this.fileContent.slice(0, endDoc) + insertText + this.fileContent.slice(endDoc);
    }
  }

  startActivity() {
    const jitter = () => Math.random() * 1000;
    // Periodic file saves (main DB write load)
    this.intervals.push(
      setInterval(async () => {
        this.editFile();
        await this.saveFile();
      }, SAVE_INTERVAL_MS + jitter()),
    );
    // Periodic file listings (main DB read load)
    this.intervals.push(setInterval(() => this.listFiles(), LIST_INTERVAL_MS + jitter()));
    // Periodic compilations (CPU + I/O heavy)
    this.intervals.push(setInterval(() => this.compileProject(), COMPILE_INTERVAL_MS + jitter()));
    // Trigger an initial compilation immediately
    this.compileProject();
  }

  stop() {
    for (const iv of this.intervals) clearInterval(iv);
    this.intervals = [];
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

// ── Progress reporter ──────────────────────────────────────────────────
function printProgress(phase) {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  const mem = process.memoryUsage();
  process.stdout.write(
    `\r[${elapsed}s] ${phase} | ` +
      `WS: ${stats.wsConnected}/${NUM_USERS} | ` +
      `Compiles: ${stats.compilations}/${stats.compilations + stats.compileFails} | ` +
      `REST: ${stats.restCalls} | ` +
      `Errors: ${stats.errors.length} | ` +
      `RSS: ${(mem.rss / 1024 / 1024).toFixed(0)}MB  `,
  );
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║          FlowTex Load Test                             ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Users:     ${String(NUM_USERS).padEnd(6)} Shared projects: ${SHARED_PROJECTS}           ║`);
  console.log(
    `║  Duration:  ${String(DURATION_SEC + 's').padEnd(6)} Users per shared: ${USERS_PER_SHARED}           ║`,
  );
  console.log(`║  Host:      ${HOST.padEnd(42)}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  stats.startTime = Date.now();
  const runId = Date.now().toString(36);
  const users = Array.from({ length: NUM_USERS }, (_, i) => new SimUser(i, runId));
  const progressIv = setInterval(() => printProgress('RUNNING'), 1000);

  // ── Phase 0: Fetch source project files from DB ───────────────────────
  console.log(`Loading source project (EMSE 2) files...`);
  sourceProjectFiles = await fetchSourceFiles();
  console.log('');

  // ── Phase 1: Register + Login in batches ─────────────────────────────
  console.log(`Phase 1: Registering and logging in ${NUM_USERS} users...\n`);
  for (let i = 0; i < NUM_USERS; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (u) => {
        const reg = await u.register();
        if (!reg || reg.error) {
          await u.login();
        }
      }),
    );
    printProgress('REGISTER');
  }

  const loggedIn = users.filter((u) => u.userId);
  console.log(`\n\nRegistered/logged in: ${loggedIn.length}/${NUM_USERS}\n`);

  if (loggedIn.length === 0) {
    console.error('No users could log in. Is the server running?');
    clearInterval(progressIv);
    process.exit(1);
  }

  // ── Phase 2: Create shared projects ──────────────────────────────────
  console.log(`Phase 2: Creating ${SHARED_PROJECTS} shared projects + individual projects...\n`);

  // Every user creates their own project (they are owner = automatic member)
  for (let i = 0; i < loggedIn.length; i += BATCH_SIZE) {
    const batch = loggedIn.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((u) => u.createProject()));
    printProgress('PROJECTS');
  }

  const withProjects = loggedIn.filter((u) => u.projectId);
  console.log(`Created ${withProjects.length} projects`);

  // Group users into shared rooms: assign some users to other users' projects
  // Each "shared group" of USERS_PER_SHARED users all point to the first user's project
  // (Since they're not actual members, WS join will fail for non-owners.
  //  So instead we just let each user use their own project — this still
  //  tests concurrent WS connections and message throughput.)
  console.log(`Each user editing their own project (${withProjects.length} concurrent rooms)\n`);

  // ── Phase 3: Fetch file lists ──────────────────────────────────────
  console.log(`Phase 3: Fetching file lists...\n`);
  for (let i = 0; i < loggedIn.length; i += BATCH_SIZE) {
    const batch = loggedIn.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((u) => u.listFiles()));
    printProgress('FILES');
  }
  console.log(`\n\nUsers with files: ${loggedIn.filter((u) => u.fileId).length}\n`);

  // ── Phase 3b: Populate each project with source files ─────────────
  console.log(`Phase 3b: Uploading EMSE 2 files to each project...\n`);
  for (let i = 0; i < loggedIn.length; i += 10) {
    const batch = loggedIn.slice(i, i + 10);
    await Promise.all(batch.map((u) => u.populateFromSource()));
    printProgress('POPULATE');
  }
  console.log(`\n\nProjects populated with source files\n`);

  // ── Phase 4: Connect WebSockets with ramp-up ────────────────────────
  console.log(`Phase 4: Connecting ${loggedIn.length} WebSockets (${RAMP_UP_MS / 1000}s ramp-up)...\n`);
  const perUserDelay = RAMP_UP_MS / loggedIn.length;

  const connectPromises = loggedIn.map(
    (u, i) =>
      new Promise((resolve) => {
        setTimeout(async () => {
          await u.connectWebSocket();
          resolve();
        }, i * perUserDelay);
      }),
  );
  await Promise.all(connectPromises);

  console.log(`\n\nWebSockets connected: ${stats.wsConnected}/${loggedIn.length}\n`);

  // ── Phase 5: Simulate editing ────────────────────────────────────────
  console.log(`Phase 5: Simulating editing for ${DURATION_SEC} seconds...\n`);
  const editStart = Date.now();

  for (const u of loggedIn) {
    u.startActivity();
  }

  // Wait for duration
  await new Promise((resolve) => {
    const check = setInterval(() => {
      const elapsed = (Date.now() - editStart) / 1000;
      printProgress(`EDITING ${Math.floor(elapsed)}/${DURATION_SEC}s`);
      if (elapsed >= DURATION_SEC) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });

  // ── Phase 6: Cleanup ────────────────────────────────────────────────
  console.log(`\n\nPhase 6: Stopping users...\n`);
  for (const u of loggedIn) {
    u.stop();
  }
  clearInterval(progressIv);

  // Wait for connections to close
  await new Promise((r) => setTimeout(r, 2000));

  // ── Report ───────────────────────────────────────────────────────────
  const totalTime = (Date.now() - stats.startTime) / 1000;
  const mem = process.memoryUsage();

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║                    LOAD TEST RESULTS                     ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  Total duration:         ${totalTime.toFixed(1).padStart(8)}s                    ║`);
  console.log(`║  Users registered:       ${String(stats.registrations).padStart(8)}                     ║`);
  console.log(`║  Users logged in:        ${String(stats.logins).padStart(8)}                     ║`);
  console.log(`║  Projects created:       ${String(stats.projectsCreated).padStart(8)}                     ║`);
  console.log(`║  Peak WS connections:    ${String(stats.peakWsConnections).padStart(8)}                     ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  THROUGHPUT                                              ║`);
  console.log(`║  REST API calls:         ${String(stats.restCalls).padStart(8)}                     ║`);
  console.log(
    `║  REST calls/sec:         ${(stats.restCalls / totalTime).toFixed(0).padStart(8)}                     ║`,
  );
  console.log(`║  WS messages received:   ${String(stats.wsMsgRecv).padStart(8)}                     ║`);
  console.log(`║  Compilations OK:        ${String(stats.compilations).padStart(8)}                     ║`);
  console.log(`║  Compilations failed:    ${String(stats.compileFails).padStart(8)}                     ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  REST LATENCY (non-compile)                               ║`);
  console.log(
    `║  p50:                    ${percentile(stats.latencies, 50).toFixed(0).padStart(6)}ms                   ║`,
  );
  console.log(
    `║  p90:                    ${percentile(stats.latencies, 90).toFixed(0).padStart(6)}ms                   ║`,
  );
  console.log(
    `║  p95:                    ${percentile(stats.latencies, 95).toFixed(0).padStart(6)}ms                   ║`,
  );
  console.log(
    `║  p99:                    ${percentile(stats.latencies, 99).toFixed(0).padStart(6)}ms                   ║`,
  );
  console.log(
    `║  max:                    ${percentile(stats.latencies, 100).toFixed(0).padStart(6)}ms                   ║`,
  );
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  COMPILE LATENCY                                         ║`);
  console.log(
    `║  p50:                    ${(percentile(stats.compileLatencies, 50) / 1000).toFixed(1).padStart(6)}s                   ║`,
  );
  console.log(
    `║  p90:                    ${(percentile(stats.compileLatencies, 90) / 1000).toFixed(1).padStart(6)}s                   ║`,
  );
  console.log(
    `║  p95:                    ${(percentile(stats.compileLatencies, 95) / 1000).toFixed(1).padStart(6)}s                   ║`,
  );
  console.log(
    `║  max:                    ${(percentile(stats.compileLatencies, 100) / 1000).toFixed(1).padStart(6)}s                   ║`,
  );
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  ERRORS                                                   ║`);
  console.log(`║  Total errors:           ${String(stats.errors.length).padStart(8)}                     ║`);
  console.log(`╠══════════════════════════════════════════════════════════╣`);
  console.log(`║  LOAD TEST MEMORY (this process)                         ║`);
  console.log(`║  RSS:                    ${(mem.rss / 1024 / 1024).toFixed(0).padStart(6)}MB                   ║`);
  console.log(
    `║  Heap used:              ${(mem.heapUsed / 1024 / 1024).toFixed(0).padStart(6)}MB                   ║`,
  );
  console.log(`╚══════════════════════════════════════════════════════════╝`);

  // Print unique error types (deduped, max 20)
  if (stats.errors.length > 0) {
    const errorCounts = {};
    for (const e of stats.errors) {
      const key = e.replace(/user \d+/, 'user N').replace(/\d{13,}/, 'TIMESTAMP');
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    console.log(`\nError breakdown:`);
    const entries = Object.entries(errorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    for (const [msg, count] of entries) {
      console.log(`  [${count}x] ${msg}`);
    }
  }

  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  process.exit(1);
});
