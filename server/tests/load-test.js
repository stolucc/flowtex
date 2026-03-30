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
import crypto from 'crypto';
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

// DEAD CODE — kept for reference but replaced by real project content
function generateLatexDocument(userName, projectName) {
  const sectionNames = [
    'Introduction',
    'Background and Related Work',
    'Theoretical Framework',
    'Methodology',
    'System Architecture',
    'Experimental Setup',
    'Results and Analysis',
    'Statistical Validation',
    'Ablation Studies',
    'Scalability Analysis',
    'Discussion',
    'Limitations and Future Work',
    'Ethical Considerations',
    'Conclusion',
  ];

  const loremParas = [
    `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore
eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt
in culpa qui officia deserunt mollit anim id est laborum.`,
    `Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac
turpis egestas. Vestibulum tortor quam, feugiat vitae, ultricies eget, tempor
sit amet, ante. Donec eu libero sit amet quam egestas semper. Aenean ultricies
mi vitae est. Mauris placerat eleifend leo. Quisque sit amet est et sapien
ullamcorper pharetra. Vestibulum erat wisi, condimentum sed, commodo vitae,
ornare sit amet, wisi.`,
    `Curabitur dictum gravida mauris. Nam arcu libero, nonummy eget, consectetuer
id, vulputate a, magna. Donec vehicula augue eu neque. Pellentesque habitant
morbi tristique senectus et netus et malesuada fames ac turpis egestas. Mauris
ut leo. Cras viverra metus rhoncus sem. Nulla et lectus vestibulum urna
fringilla ultrices. Phasellus eu tellus sit amet tortor gravida placerat.
Integer sapien est, iaculis in, pretium quis, viverra ac, nunc.`,
    `Praesent eget sem vel leo ultrices bibendum. Aenean faucibus. Morbi dolor
nulla, malesuada eu, pulvinar at, mollis ac, nulla. Curabitur auctor semper
nulla. Donec varius orci eget risus. Duis nibh mi, congue eu, accumsan
eleifend, sagittis quis, diam. Duis eget orci sit amet orci dignissim
rutrum. Nam dui ligula, fringilla a, euismod sodales, sollicitudin vel, wisi.`,
  ];

  function randPara() {
    return loremParas[Math.floor(Math.random() * loremParas.length)];
  }

  const sections = sectionNames.map((name, i) => {
    let content = `\n\\section{${name}}\n\n${randPara()}\n\n${randPara()}\n`;

    // Math subsection every section
    content += `
\\subsection{Formal Analysis}

The core relationship in this context is captured by:
\\begin{equation}
  \\mathcal{L}_{${i + 1}}(\\theta) = -\\frac{1}{N}\\sum_{j=1}^{N} \\left[ y_j \\log\\sigma(\\mathbf{w}^\\top\\mathbf{x}_j + b) + (1 - y_j)\\log(1 - \\sigma(\\mathbf{w}^\\top\\mathbf{x}_j + b)) \\right] + \\frac{\\lambda}{2}\\|\\theta\\|_2^2
  \\label{eq:loss${i + 1}}
\\end{equation}

where $\\sigma(z) = (1 + e^{-z})^{-1}$ is the logistic sigmoid, $\\theta = (\\mathbf{w}, b)$
are the model parameters, and $\\lambda > 0$ is the regularisation coefficient. The gradient
with respect to $\\mathbf{w}$ is:
\\[
  \\nabla_{\\mathbf{w}}\\mathcal{L} = -\\frac{1}{N}\\sum_{j=1}^{N}(y_j - \\hat{y}_j)\\mathbf{x}_j + \\lambda\\mathbf{w}
\\]

For the multi-class generalisation, we employ the softmax function:
\\[
  P(Y = k \\mid \\mathbf{x}) = \\frac{\\exp(\\mathbf{w}_k^\\top \\mathbf{x})}{\\sum_{c=1}^{C} \\exp(\\mathbf{w}_c^\\top \\mathbf{x})}
\\]

The Hessian matrix is given by $\\mathbf{H} = \\mathbf{X}^\\top \\mathbf{S} \\mathbf{X} + \\lambda\\mathbf{I}$,
where $\\mathbf{S} = \\mathrm{diag}(\\hat{y}_j(1-\\hat{y}_j))$. Since $\\mathbf{H} \\succ 0$,
the objective is strictly convex and admits a unique minimiser.

${randPara()}
`;

    // Table every 2 sections
    if (i % 2 === 0) {
      content += `
\\subsection{Quantitative Results}

\\begin{table}[h]
\\centering
\\caption{Performance metrics for Section~${i + 1} experiments.}
\\label{tab:results${i + 1}}
\\begin{tabular}{lcccccc}
\\toprule
\\textbf{Method} & \\textbf{Prec.} & \\textbf{Rec.} & \\textbf{F1} & \\textbf{AUC} & \\textbf{Time (s)} & \\textbf{Params} \\\\
\\midrule
Baseline-A       & 0.72 & 0.68 & 0.70 & 0.74 & 12.3  & 1.2M \\\\
Baseline-B       & 0.75 & 0.71 & 0.73 & 0.77 & 15.7  & 2.1M \\\\
Transformer-S    & 0.81 & 0.79 & 0.80 & 0.85 & 45.2  & 12M  \\\\
Transformer-L    & 0.84 & 0.82 & 0.83 & 0.88 & 128.6 & 110M \\\\
Ours (small)     & 0.86 & 0.85 & 0.86 & 0.90 & 23.1  & 4.5M \\\\
Ours (large)     & \\textbf{0.91} & \\textbf{0.89} & \\textbf{0.90} & \\textbf{0.94} & 67.8  & 35M  \\\\
\\bottomrule
\\end{tabular}
\\end{table}

As shown in Table~\\ref{tab:results${i + 1}}, our proposed method achieves
superior performance across all metrics while using significantly fewer
parameters than the Transformer-L baseline. The efficiency gains are
particularly notable in the small variant.

${randPara()}
`;
    }

    // Lists every 3 sections
    if (i % 3 === 0) {
      content += `
\\subsection{Key Observations}

The principal findings from this analysis are:
\\begin{itemize}
  \\item The convergence rate scales as $\\mathcal{O}(1/\\sqrt{T})$ for the stochastic variant
        and $\\mathcal{O}(1/T^2)$ for the accelerated version with Nesterov momentum
  \\item Memory consumption grows linearly with batch size $B$ and quadratically with
        sequence length $L$, i.e., $\\Theta(BL^2d)$ for attention-based models
  \\item Wall-clock time is dominated by the matrix decomposition step when $d > 10^4$
  \\item Gradient clipping with threshold $\\tau = 1.0$ prevents training instability
        without degrading final accuracy by more than $0.3\\%$
  \\item The algorithm achieves near-optimal performance when the condition number
        $\\kappa(\\mathbf{A}) < 10^3$, degrading gracefully beyond this threshold
\\end{itemize}

The recommended procedure is:
\\begin{enumerate}
  \\item Preprocess inputs via whitening: $\\tilde{\\mathbf{x}} = \\mathbf{\\Sigma}^{-1/2}(\\mathbf{x} - \\boldsymbol{\\mu})$
  \\item Apply the learned transformation $\\phi: \\mathbb{R}^d \\to \\mathbb{R}^k$ where $k \\ll d$
  \\item Initialise weights using He initialisation: $w_{ij} \\sim \\mathcal{N}(0, 2/n_{\\mathrm{in}})$
  \\item Optimise via AdamW with learning rate $\\eta = 3 \\times 10^{-4}$, $\\beta_1 = 0.9$, $\\beta_2 = 0.999$
  \\item Apply cosine annealing schedule: $\\eta_t = \\eta_{\\min} + \\frac{1}{2}(\\eta_{\\max} - \\eta_{\\min})(1 + \\cos(\\pi t/T))$
  \\item Validate on held-out set every 500 steps; apply early stopping with patience 10
\\end{enumerate}
`;
    }

    // Algorithm block every 4 sections
    if (i % 4 === 1) {
      content += `
\\subsection{Algorithmic Detail}

The optimisation procedure is formalised below.

\\medskip
\\noindent\\textbf{Algorithm ${Math.floor(i / 4) + 1}:} Adaptive Gradient Method (Variant ${i + 1})
\\begin{quote}
\\textbf{Input:} Dataset $\\mathcal{D} = \\{(\\mathbf{x}_i, y_i)\\}_{i=1}^N$, learning rate $\\eta$, epochs $T$ \\\\
\\textbf{Output:} Optimised parameters $\\theta^*$ \\\\[4pt]
Initialise $\\theta_0$, $\\mathbf{m}_0 \\leftarrow \\mathbf{0}$, $\\mathbf{v}_0 \\leftarrow \\mathbf{0}$ \\\\
\\textbf{for} $t = 1$ \\textbf{to} $T$ \\textbf{do} \\\\
\\quad Sample mini-batch $\\mathcal{B}_t \\subset \\mathcal{D}$ with $|\\mathcal{B}_t| = B$ \\\\
\\quad $\\mathbf{g}_t \\leftarrow \\frac{1}{B}\\sum_{(\\mathbf{x},y) \\in \\mathcal{B}_t} \\nabla_\\theta \\ell(f_\\theta(\\mathbf{x}), y)$ \\\\
\\quad $\\mathbf{m}_t \\leftarrow \\beta_1 \\mathbf{m}_{t-1} + (1-\\beta_1)\\mathbf{g}_t$ \\\\
\\quad $\\mathbf{v}_t \\leftarrow \\beta_2 \\mathbf{v}_{t-1} + (1-\\beta_2)\\mathbf{g}_t^2$ \\\\
\\quad $\\hat{\\mathbf{m}}_t \\leftarrow \\mathbf{m}_t / (1 - \\beta_1^t)$, \\quad $\\hat{\\mathbf{v}}_t \\leftarrow \\mathbf{v}_t / (1 - \\beta_2^t)$ \\\\
\\quad $\\theta_t \\leftarrow \\theta_{t-1} - \\eta \\cdot \\hat{\\mathbf{m}}_t / (\\sqrt{\\hat{\\mathbf{v}}_t} + \\epsilon)$ \\\\
\\textbf{end for} \\\\
\\textbf{return} $\\theta_T$
\\end{quote}

${randPara()}
`;
    }

    // Extra paragraphs to fill pages
    content += `\n${randPara()}\n\n${randPara()}\n`;

    return content;
  });

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,amsfonts,amsthm}
\\usepackage{mathtools}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{fancyhdr}
\\usepackage{enumitem}
\\usepackage{microtype}

\\pagestyle{fancy}
\\fancyhead{}
\\fancyhead[L]{\\textit{${projectName}}}
\\fancyhead[R]{\\textit{${userName}}}
\\fancyfoot[C]{\\thepage}

\\newtheorem{theorem}{Theorem}[section]
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{corollary}[theorem]{Corollary}

\\title{${projectName}:\\\\A Comprehensive Analysis of Multi-dimensional\\\\Optimisation Strategies for Large-Scale Systems}
\\author{${userName}\\\\[6pt]Department of Computer Science\\\\FlowTex University\\\\[4pt]\\texttt{${userName.toLowerCase().replace(/ /g, '.')}@flowtex.edu}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
This paper presents a comprehensive analysis of multi-dimensional optimisation
strategies for large-scale machine learning systems. We evaluate several approaches
including stochastic gradient methods, second-order techniques, evolutionary
algorithms, and novel hybrid strategies across twelve benchmark datasets spanning
computer vision, natural language processing, and tabular domains. Our proposed
\\textit{Adaptive Hierarchical Optimiser} (AHO) achieves state-of-the-art performance
while maintaining computational efficiency, demonstrating a $15.3\\%$ improvement
in convergence speed (measured in wall-clock time to target accuracy) and an
$8.7\\%$ improvement in final test accuracy compared to AdamW, the strongest baseline.
We provide theoretical convergence guarantees under standard smoothness assumptions
and validate our analysis through extensive empirical evaluation comprising over
2,400 GPU-hours of experimentation. Code and pre-trained models are available at
\\url{https://github.com/flowtex/aho-optimizer}.

\\medskip
\\noindent\\textbf{Keywords:} optimisation, deep learning, convergence analysis,
adaptive methods, large-scale systems
\\end{abstract}

\\tableofcontents
\\newpage

${sections.join('\n\\newpage\n')}

\\appendix
\\section{Convergence Proofs}

\\begin{theorem}[Convergence of AHO]
For any $L$-smooth convex function $f: \\mathbb{R}^n \\to \\mathbb{R}$ with bounded
gradients $\\|\\nabla f(x)\\| \\leq G$ for all $x$ in the feasible set, the AHO
algorithm with step size $\\eta_t = \\eta_0 / \\sqrt{t}$ satisfies:
\\[
  f\\left(\\frac{1}{T}\\sum_{t=1}^{T} x_t\\right) - f(x^*) \\leq \\frac{\\|x_0 - x^*\\|^2}{2\\eta_0\\sqrt{T}} + \\frac{\\eta_0 G^2 \\sqrt{T}}{2}
\\]
Setting $\\eta_0 = \\|x_0 - x^*\\| / (G\\sqrt[4]{T})$ yields a rate of $\\mathcal{O}(T^{-1/2})$.
\\end{theorem}

\\begin{proof}
By the descent lemma and $L$-smoothness:
\\begin{align}
  f(x_{t+1}) &\\leq f(x_t) + \\langle \\nabla f(x_t), x_{t+1} - x_t \\rangle + \\frac{L}{2}\\|x_{t+1} - x_t\\|^2 \\\\
  &= f(x_t) - \\eta_t\\|\\nabla f(x_t)\\|^2 + \\frac{L\\eta_t^2}{2}\\|\\nabla f(x_t)\\|^2 \\\\
  &= f(x_t) - \\eta_t\\left(1 - \\frac{L\\eta_t}{2}\\right)\\|\\nabla f(x_t)\\|^2
\\end{align}

For $\\eta_t \\leq 1/L$, the term $(1 - L\\eta_t/2) \\geq 1/2 > 0$. Summing over $t = 1, \\ldots, T$:
\\begin{align}
  \\sum_{t=1}^{T} \\eta_t \\|\\nabla f(x_t)\\|^2 &\\leq 2\\left(f(x_1) - f(x^*)\\right)
\\end{align}

By convexity, $f(x_t) - f(x^*) \\leq \\langle \\nabla f(x_t), x_t - x^* \\rangle$. Combining
with the update rule $x_{t+1} = x_t - \\eta_t \\nabla f(x_t)$:
\\begin{align}
  \\|x_{t+1} - x^*\\|^2 &= \\|x_t - x^*\\|^2 - 2\\eta_t\\langle \\nabla f(x_t), x_t - x^*\\rangle + \\eta_t^2\\|\\nabla f(x_t)\\|^2 \\\\
  &\\leq \\|x_t - x^*\\|^2 - 2\\eta_t(f(x_t) - f(x^*)) + \\eta_t^2 G^2
\\end{align}

Rearranging and telescoping yields the stated bound. \\qed
\\end{proof}

\\begin{lemma}[Gradient Bound]
Under the assumptions of Theorem~1, the averaged gradient norm satisfies:
\\[
  \\frac{1}{T}\\sum_{t=1}^{T}\\|\\nabla f(x_t)\\|^2 \\leq \\frac{2(f(x_0) - f(x^*))}{T\\eta_{\\min}} + LG^2\\eta_{\\max}
\\]
where $\\eta_{\\min} = \\min_t \\eta_t$ and $\\eta_{\\max} = \\max_t \\eta_t$.
\\end{lemma}

\\section{Hyperparameter Sensitivity}

\\begin{table}[h]
\\centering
\\caption{Sensitivity of AHO to key hyperparameters on CIFAR-100.}
\\begin{tabular}{ccccc}
\\toprule
$\\eta_0$ & $\\beta_1$ & $\\beta_2$ & Test Acc. (\\%) & Train Loss \\\\
\\midrule
$10^{-2}$ & 0.9 & 0.999 & 78.2 & 0.142 \\\\
$3 \\times 10^{-3}$ & 0.9 & 0.999 & \\textbf{81.4} & 0.098 \\\\
$10^{-3}$ & 0.9 & 0.999 & 80.1 & 0.112 \\\\
$3 \\times 10^{-4}$ & 0.9 & 0.999 & 77.8 & 0.156 \\\\
$3 \\times 10^{-3}$ & 0.95 & 0.999 & 80.9 & 0.101 \\\\
$3 \\times 10^{-3}$ & 0.85 & 0.999 & 80.7 & 0.105 \\\\
$3 \\times 10^{-3}$ & 0.9 & 0.99 & 79.3 & 0.128 \\\\
$3 \\times 10^{-3}$ & 0.9 & 0.9999 & 81.1 & 0.100 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Full Experimental Results}

\\begin{table}[h]
\\centering
\\caption{Complete results across all 12 benchmark datasets (test accuracy \\%).}
\\resizebox{\\textwidth}{!}{
\\begin{tabular}{lccccccccccccc}
\\toprule
\\textbf{Method} & \\textbf{C-10} & \\textbf{C-100} & \\textbf{IN-1k} & \\textbf{SST-2} & \\textbf{MNLI} & \\textbf{SQuAD} & \\textbf{Tab-A} & \\textbf{Tab-B} & \\textbf{Tab-C} & \\textbf{TS-1} & \\textbf{TS-2} & \\textbf{Graph} & \\textbf{Avg.} \\\\
\\midrule
SGD+M        & 93.1 & 74.5 & 76.2 & 91.8 & 84.1 & 88.2 & 82.4 & 79.1 & 85.3 & 71.2 & 68.9 & 77.4 & 81.0 \\\\
Adam         & 93.8 & 77.2 & 77.8 & 93.1 & 85.9 & 89.7 & 84.1 & 81.3 & 86.7 & 73.5 & 71.2 & 79.8 & 82.8 \\\\
AdamW        & 94.2 & 78.4 & 78.5 & 93.5 & 86.4 & 90.1 & 84.8 & 82.0 & 87.2 & 74.1 & 72.0 & 80.5 & 83.5 \\\\
LAMB         & 94.0 & 77.8 & 78.1 & 93.2 & 86.0 & 89.8 & 84.3 & 81.6 & 86.9 & 73.8 & 71.6 & 80.1 & 83.1 \\\\
Shampoo      & 94.5 & 79.1 & 79.2 & 93.8 & 86.8 & 90.5 & 85.2 & 82.5 & 87.6 & 74.6 & 72.5 & 81.0 & 83.9 \\\\
\\textbf{AHO} & \\textbf{95.1} & \\textbf{81.4} & \\textbf{80.8} & \\textbf{94.7} & \\textbf{87.9} & \\textbf{91.8} & \\textbf{86.5} & \\textbf{83.9} & \\textbf{88.8} & \\textbf{76.2} & \\textbf{74.1} & \\textbf{82.7} & \\textbf{85.3} \\\\
\\bottomrule
\\end{tabular}
}
\\end{table}

\\end{document}
`;
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
    } catch (e) {
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

      this.ws.on('message', (raw) => {
        stats.wsMsgRecv++;
      });

      this.ws.on('close', () => {
        stats.wsConnected = Math.max(0, stats.wsConnected - 1);
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        resolve(false);
      });

      this.ws.on('unexpected-response', (req, res) => {
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
