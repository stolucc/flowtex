/**
 * FlowTex Load Test — 500 users editing 100 documents with realistic keystrokes.
 *
 * Usage:
 *   node --env-file=.env loadtest.js [--users N] [--docs N] [--duration S] [--compile S]
 *
 * Defaults: 500 users, 100 documents, 120 seconds.
 * --compile S: each project triggers a compile every S seconds (default: off).
 *              The interval is jittered ±25% per project to avoid thundering herd.
 *              Note: server rate limit is 5 compiles/project/60s, so use ≥15s.
 * Requires the FlowTex server to be running on PORT (default 3001).
 */

// Allow self-signed certs for fetch() in dev
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'crypto';
import pg from 'pg';
import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';

// ── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? Number(args[idx + 1]) : fallback;
}

const NUM_USERS = getArg('users', 500);
const NUM_DOCS = getArg('docs', 100);
const DURATION_S = getArg('duration', 120);
const COMPILE_INTERVAL_S = getArg('compile', 0); // 0 = disabled
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BASE_URL = `https://localhost:${PORT}`;
const WS_URL = `wss://localhost:${PORT}/ws`;

if (!SESSION_SECRET) {
  console.error('SESSION_SECRET must be set (load .env)');
  process.exit(1);
}

// ── Database ────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  database: process.env.PGDATABASE || 'flowtex',
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  max: 5, // load test's own pool — keep small
});

// ── Helpers ─────────────────────────────────────────────────────────────
function signCookie(sessionId) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('base64').replace(/=+$/, '');
  return `s:${sessionId}.${mac}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Realistic typing: 50-200ms between chars, occasional pauses (300-800ms)
function nextKeystrokeDelay() {
  if (Math.random() < 0.08) return 300 + Math.random() * 500; // thinking pause
  return 50 + Math.random() * 150;
}

// Corpus of LaTeX-ish text to type
const CORPUS = [
  '\\section{Introduction}\n',
  'This paper presents a novel approach to ',
  'collaborative editing in real-time environments. ',
  'We demonstrate that our method achieves $O(n \\log n)$ complexity ',
  'while maintaining consistency across all connected clients.\n\n',
  '\\subsection{Background}\n',
  'The problem of operational transformation has been extensively studied ',
  'in the literature \\cite{ellis1989concurrency, sun1998operational}. ',
  'However, existing solutions often struggle with ',
  'latency spikes under heavy concurrent load.\n\n',
  '\\begin{equation}\n  E = mc^2\n\\end{equation}\n\n',
  'As shown in Figure~\\ref{fig:results}, the throughput scales linearly ',
  'with the number of active editors up to approximately 50 users per document.\n\n',
  '\\begin{itemize}\n  \\item Low latency synchronization\n  \\item Conflict resolution\n  \\item Undo/redo support\n\\end{itemize}\n\n',
  'The experimental results confirm our hypothesis. ',
  'Further work is needed to explore the implications of ',
  'network partitions on document convergence.\n\n',
];

// ── Realistic document generator (EMSE-style paper) ─────────────────────
function generateDocument(docIndex) {
  const titles = [
    'An Empirical Study of Code Review Practices in Open Source Projects',
    'Investigating the Impact of Technical Debt on Software Maintenance',
    'A Large-Scale Analysis of Continuous Integration Build Failures',
    'Understanding Developer Sentiment Through Commit Messages',
    'On the Relationship Between Code Complexity and Bug Density',
    'Mining Software Repositories for Architectural Pattern Detection',
    'An Empirical Investigation of Test Suite Effectiveness in CI/CD Pipelines',
    'Cross-Project Defect Prediction Using Transfer Learning',
    'The Evolution of API Design Patterns: A Longitudinal Study',
    'Automated Detection of Security Vulnerabilities in Web Applications',
  ];
  const title = titles[docIndex % titles.length];

  return `\\documentclass[preprint,12pt]{elsarticle}

\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{xcolor}
\\usepackage{listings}
\\usepackage{algorithm}
\\usepackage{algpseudocode}

\\journal{Empirical Software Engineering}

\\begin{document}

\\begin{frontmatter}

\\title{${title}}

\\author[inst1]{Alice Johnson}
\\author[inst2]{Bob Smith}
\\author[inst1]{Carol Williams}

\\address[inst1]{Department of Computer Science, University of Technology, Dublin, Ireland}
\\address[inst2]{Software Engineering Institute, Technical University of Munich, Germany}

\\begin{abstract}
Context: Modern software development practices increasingly rely on automated tools and collaborative workflows. However, the empirical evidence supporting many of these practices remains limited, particularly in the context of large-scale industrial projects.

Objective: This study aims to provide a comprehensive empirical analysis of software development practices across ${100 + docIndex} open-source projects, encompassing over ${(docIndex + 1) * 50},000 commits and ${(docIndex + 1) * 10},000 pull requests.

Method: We employ a mixed-methods research approach combining quantitative analysis of repository metrics with qualitative analysis of developer surveys ($n=${200 + docIndex * 10}$). We use statistical methods including regression analysis, survival analysis, and Bayesian inference to model the relationships between development practices and software quality outcomes.

Results: Our findings indicate that projects adopting structured code review processes experience ${15 + (docIndex % 20)}\\% fewer post-release defects compared to projects without formal review processes. Furthermore, we observe a statistically significant correlation ($p < 0.001$) between test coverage and reduction in critical bugs.

Conclusions: The results provide actionable insights for software development teams seeking to optimize their development workflows. We identify key practices that correlate with improved software quality and provide recommendations for their adoption.
\\end{abstract}

\\begin{keyword}
empirical software engineering \\sep code review \\sep software quality \\sep mining software repositories \\sep continuous integration
\\end{keyword}

\\end{frontmatter}

\\section{Introduction}
\\label{sec:introduction}

Software engineering has evolved significantly over the past two decades, with the widespread adoption of agile methodologies, continuous integration, and DevOps practices fundamentally changing how software is developed and delivered~\\cite{fitzgerald2017continuous}. Despite this evolution, many development practices are adopted based on anecdotal evidence or industry trends rather than rigorous empirical evaluation~\\cite{shull2008role}.

The importance of empirical evidence in software engineering cannot be overstated. As Basili et al.~\\cite{basili1986experimentation} argued, the field must move beyond individual experience and opinion toward a more scientific foundation. This sentiment has been echoed by numerous researchers over the years~\\cite{kitchenham2004evidence, wohlin2012experimentation}, yet significant gaps remain in our understanding of which practices truly contribute to software quality.

In this paper, we present a large-scale empirical study examining the relationship between development practices and software quality outcomes. Our study encompasses ${100 + docIndex} open-source projects hosted on GitHub, spanning multiple programming languages and application domains. We analyze over ${(docIndex + 1) * 50},000 commits, ${(docIndex + 1) * 10},000 pull requests, and ${(docIndex + 1) * 5},000 issue reports to build a comprehensive picture of modern development practices.

Our research is guided by the following research questions:

\\begin{itemize}
    \\item \\textbf{RQ1:} To what extent do code review practices correlate with post-release defect density?
    \\item \\textbf{RQ2:} How does test coverage relate to the frequency and severity of production bugs?
    \\item \\textbf{RQ3:} What is the impact of continuous integration adoption on release frequency and code quality?
    \\item \\textbf{RQ4:} How do developer experience and team composition affect code review effectiveness?
\\end{itemize}

The remainder of this paper is organized as follows. Section~\\ref{sec:background} provides background and related work. Section~\\ref{sec:methodology} describes our research methodology. Section~\\ref{sec:results} presents our findings. Section~\\ref{sec:discussion} discusses the implications. Section~\\ref{sec:threats} addresses threats to validity, and Section~\\ref{sec:conclusion} concludes the paper.

\\section{Background and Related Work}
\\label{sec:background}

\\subsection{Code Review Practices}

Code review has been recognized as one of the most effective quality assurance techniques in software engineering~\\cite{fagan1976design}. Modern code review, as practiced in open-source and industrial settings, differs significantly from Fagan's original inspection process. Contemporary reviews are typically lightweight, tool-supported, and asynchronous~\\cite{bacchelli2013expectations}.

Rigby and Bird~\\cite{rigby2013convergent} conducted a seminal study comparing code review practices across several open-source and commercial projects. They found that despite differences in tools and processes, review practices converged on similar characteristics: reviews involve a small number of reviewers (typically 2), cover relatively small changes, and provide rapid feedback.

McIntosh et al.~\\cite{mcintosh2016empirical} examined the relationship between code review coverage and software quality. Their study of the Qt, VTK, and ITK projects found that components with higher review coverage experienced fewer post-release defects. However, they also noted that the relationship was not strictly linear, suggesting diminishing returns at very high coverage levels.

\\subsection{Test Coverage and Software Quality}

The relationship between test coverage and software quality has been a subject of ongoing debate in the software engineering community. While intuition suggests that higher test coverage should lead to fewer bugs, the empirical evidence is more nuanced~\\cite{inozemtseva2014coverage}.

Inozemtseva and Holmes~\\cite{inozemtseva2014coverage} found that test suite size, rather than coverage level, was a stronger predictor of fault detection effectiveness. However, their study was limited to a relatively small number of Java projects and may not generalize to other contexts.

More recent work by Kochhar et al.~\\cite{kochhar2017practitioners} surveyed 750 software practitioners about their views on test coverage. The majority believed that high coverage was important, but there was significant disagreement about what constituted an adequate coverage level.

\\subsection{Continuous Integration}

Continuous Integration (CI) has become a standard practice in modern software development. Originally proposed by Beck~\\cite{beck2000extreme} as part of Extreme Programming, CI involves developers integrating their work frequently, with each integration verified by an automated build and test suite.

Hilton et al.~\\cite{hilton2016usage} conducted the first large-scale study of CI usage in open-source projects. They found that projects using CI released more than twice as often as those that did not, and were more likely to accept contributions from external developers.

Vasilescu et al.~\\cite{vasilescu2015quality} examined the impact of CI on code quality and developer productivity. Using data from 246 GitHub projects, they found that CI was associated with fewer bugs and higher developer productivity, though the effect sizes varied across project types.

\\section{Research Methodology}
\\label{sec:methodology}

\\subsection{Data Collection}

We collected data from GitHub using the GitHub REST API (v3) and the GHTorrent dataset~\\cite{gousios2013ghtorent}. Our data collection process proceeded in three phases:

\\begin{enumerate}
    \\item \\textbf{Project Selection:} We identified candidate projects using the following criteria: (a) at least 1,000 commits, (b) at least 50 contributors, (c) at least 100 pull requests, and (d) active development within the past year.
    \\item \\textbf{Repository Mining:} For each selected project, we extracted commit histories, pull request data, issue reports, CI build logs, and test coverage reports.
    \\item \\textbf{Developer Survey:} We distributed an online survey to contributors of the selected projects, receiving $n=${200 + docIndex * 10}$ valid responses (response rate: ${28 + (docIndex % 15)}\\%).
\\end{enumerate}

Table~\\ref{tab:dataset} summarizes the characteristics of our dataset.

\\begin{table}[htbp]
\\centering
\\caption{Dataset characteristics}
\\label{tab:dataset}
\\begin{tabular}{lr}
\\toprule
\\textbf{Metric} & \\textbf{Value} \\\\
\\midrule
Projects analyzed & ${100 + docIndex} \\\\
Total commits & ${(docIndex + 1) * 50},247 \\\\
Total pull requests & ${(docIndex + 1) * 10},891 \\\\
Total issues & ${(docIndex + 1) * 5},432 \\\\
Programming languages & 12 \\\\
Survey respondents & ${200 + docIndex * 10} \\\\
Time span & Jan 2019 -- Dec 2024 \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\subsection{Analysis Methods}

We employed several statistical and machine learning techniques to analyze our data:

\\paragraph{Regression Analysis} We used negative binomial regression to model defect counts as a function of development practices, controlling for project size, age, and programming language. The model is specified as:

\\begin{equation}
\\log(E[Y_i]) = \\beta_0 + \\beta_1 x_{review} + \\beta_2 x_{coverage} + \\beta_3 x_{ci} + \\sum_{j=1}^{k} \\gamma_j z_j + \\epsilon_i
\\label{eq:regression}
\\end{equation}

where $Y_i$ represents the defect count for project $i$, $x_{review}$, $x_{coverage}$, and $x_{ci}$ are our primary independent variables, and $z_j$ are control variables.

\\paragraph{Survival Analysis} We used Cox proportional hazards models to analyze the time-to-fix for reported bugs:

\\begin{equation}
h(t|\\mathbf{x}) = h_0(t) \\exp(\\boldsymbol{\\beta}^T \\mathbf{x})
\\label{eq:survival}
\\end{equation}

\\paragraph{Bayesian Analysis} For RQ4, we employed Bayesian hierarchical models to account for the nested structure of our data (developers within projects):

\\begin{align}
y_{ij} &\\sim \\text{Normal}(\\mu_{ij}, \\sigma^2) \\\\
\\mu_{ij} &= \\alpha_j + \\beta_j x_{ij} \\\\
\\alpha_j &\\sim \\text{Normal}(\\mu_\\alpha, \\sigma_\\alpha^2) \\\\
\\beta_j &\\sim \\text{Normal}(\\mu_\\beta, \\sigma_\\beta^2)
\\end{align}

\\section{Results}
\\label{sec:results}

\\subsection{RQ1: Code Review and Defect Density}

Our analysis reveals a statistically significant negative relationship between code review coverage and post-release defect density. Projects with review coverage above 80\\% experienced ${15 + (docIndex % 20)}\\% fewer post-release defects compared to projects with coverage below 50\\% ($p < 0.001$, Cohen's $d = 0.${45 + (docIndex % 30)}$).

Table~\\ref{tab:review_results} presents the regression results for our defect density model.

\\begin{table}[htbp]
\\centering
\\caption{Negative binomial regression results for defect density (RQ1)}
\\label{tab:review_results}
\\begin{tabular}{lrrr}
\\toprule
\\textbf{Variable} & \\textbf{Coefficient} & \\textbf{Std. Error} & \\textbf{$p$-value} \\\\
\\midrule
Review coverage & $-0.${42 + (docIndex % 30)}$ & $0.087$ & $< 0.001$ \\\\
Reviewer count & $-0.${18 + (docIndex % 15)}$ & $0.064$ & $0.005$ \\\\
Review response time & $0.${15 + (docIndex % 20)}$ & $0.072$ & $0.038$ \\\\
Project size (log) & $0.312$ & $0.045$ & $< 0.001$ \\\\
Project age & $-0.089$ & $0.033$ & $0.007$ \\\\
\\bottomrule
\\end{tabular}
\\end{table}

Interestingly, we find that the number of reviewers per change also has a significant effect. Changes reviewed by two or more developers had ${22 + (docIndex % 15)}\\% fewer subsequent bug-fix commits compared to single-reviewer changes.

\\subsection{RQ2: Test Coverage and Bug Frequency}

The relationship between test coverage and bug frequency follows a non-linear pattern. Figure~\\ref{fig:coverage_bugs} illustrates this relationship, showing a steep decline in bug frequency as coverage increases from 0\\% to approximately 60\\%, followed by diminishing returns.

Our regression analysis (Equation~\\ref{eq:regression}) confirms this finding. The coefficient for test coverage is significant ($\\beta_2 = -0.${38 + (docIndex % 25)}$, $p < 0.001$), and adding a quadratic term improves model fit (AIC reduction of ${15 + (docIndex % 20)}$).

After controlling for test suite size, we find that coverage still has a significant independent effect on defect density, contrary to the findings of Inozemtseva and Holmes~\\cite{inozemtseva2014coverage}. We attribute this discrepancy to our larger and more diverse dataset.

\\subsection{RQ3: Continuous Integration Impact}

Projects that adopted CI experienced significant improvements in both release frequency and code quality metrics:

\\begin{itemize}
    \\item Release frequency increased by ${(docIndex % 5) + 2}.${(docIndex % 10)}$\\times$ on average
    \\item Median time-to-fix for critical bugs decreased from ${14 + (docIndex % 7)} days to ${6 + (docIndex % 4)} days
    \\item Build failure rate stabilized at ${8 + (docIndex % 12)}\\% after initial adoption
    \\item Pull request merge time decreased by ${30 + (docIndex % 20)}\\%
\\end{itemize}

The survival analysis (Equation~\\ref{eq:survival}) shows that CI adoption is associated with a hazard ratio of ${1 + (docIndex % 3)}.${45 + (docIndex % 40)} for bug resolution, indicating faster resolution times.

\\subsection{RQ4: Developer Experience and Review Effectiveness}

Our Bayesian hierarchical model reveals that developer experience significantly moderates the effectiveness of code reviews. Specifically:

\\begin{enumerate}
    \\item Senior developers (>5 years experience) identify ${40 + (docIndex % 20)}\\% more design-level issues during reviews compared to junior developers.
    \\item However, junior developers are more likely to identify issues related to coding standards and documentation.
    \\item Teams with a mix of experience levels achieve the highest overall review effectiveness.
\\end{enumerate}

The posterior distributions of our model parameters are summarized in Table~\\ref{tab:bayesian_results}.

\\begin{table}[htbp]
\\centering
\\caption{Bayesian model posterior summaries (RQ4)}
\\label{tab:bayesian_results}
\\begin{tabular}{lrrr}
\\toprule
\\textbf{Parameter} & \\textbf{Mean} & \\textbf{95\\% CI Lower} & \\textbf{95\\% CI Upper} \\\\
\\midrule
$\\mu_\\alpha$ & $2.${34 + (docIndex % 50)} & $1.87$ & $2.81$ \\\\
$\\mu_\\beta$ (experience) & $0.${42 + (docIndex % 30)} & $0.28$ & $0.56$ \\\\
$\\sigma_\\alpha$ & $0.${67 + (docIndex % 20)} & $0.45$ & $0.89$ \\\\
$\\sigma_\\beta$ & $0.${23 + (docIndex % 15)} & $0.15$ & $0.31$ \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\section{Discussion}
\\label{sec:discussion}

\\subsection{Implications for Practice}

Our findings have several practical implications for software development teams:

\\begin{enumerate}
    \\item \\textbf{Prioritize code review coverage:} Teams should aim for at least 80\\% review coverage to maximize the quality benefits. However, the marginal benefit decreases beyond this threshold, suggesting that 100\\% coverage may not be cost-effective.

    \\item \\textbf{Target meaningful test coverage:} Rather than pursuing arbitrary coverage targets, teams should focus on achieving approximately 60\\% line coverage as a baseline, with additional effort directed toward critical components.

    \\item \\textbf{Invest in CI infrastructure:} The benefits of CI extend beyond catching build failures. Our data shows that CI adoption catalyzes improvements in release processes, code quality, and contributor engagement.

    \\item \\textbf{Leverage experience diversity:} Teams should structure code reviews to take advantage of the complementary strengths of developers with different experience levels.
\\end{enumerate}

\\subsection{Implications for Research}

This study opens several avenues for future research:

\\begin{itemize}
    \\item Investigating the causal mechanisms behind the observed correlations, potentially through controlled experiments or quasi-experimental designs.
    \\item Extending the analysis to include proprietary software projects, which may exhibit different patterns due to different development contexts.
    \\item Developing automated tools that can recommend optimal review and testing strategies based on project characteristics.
    \\item Examining the long-term evolution of development practices and their cumulative impact on software quality.
\\end{itemize}

\\section{Threats to Validity}
\\label{sec:threats}

\\subsection{Internal Validity}

The primary threat to internal validity is the potential for confounding variables. While we control for several project characteristics, unmeasured factors such as organizational culture, team communication practices, and market pressures may influence both development practices and quality outcomes. We mitigate this threat through our mixed-methods approach, using survey data to complement repository mining.

\\subsection{External Validity}

Our study focuses on open-source projects hosted on GitHub. While GitHub hosts a diverse set of projects, our findings may not generalize to proprietary software development or projects using other hosting platforms. Furthermore, the projects in our sample tend to be larger and more mature than the average GitHub project, which may limit generalizability to smaller projects.

\\subsection{Construct Validity}

We use post-release defect counts as a proxy for software quality. While defect density is a widely used quality metric, it does not capture all aspects of software quality, such as performance, usability, or maintainability. Additionally, our test coverage measurements are limited to line coverage, which may not fully reflect the thoroughness of testing.

\\section{Conclusion}
\\label{sec:conclusion}

This paper presents a comprehensive empirical study of software development practices and their relationship to software quality. Through the analysis of ${100 + docIndex} open-source projects and a survey of ${200 + docIndex * 10} developers, we provide evidence that code review practices, test coverage, and CI adoption all contribute positively to software quality outcomes.

Our key findings are: (1) code review coverage above 80\\% is associated with ${15 + (docIndex % 20)}\\% fewer post-release defects; (2) test coverage has a non-linear relationship with bug frequency, with diminishing returns above 60\\%; (3) CI adoption improves both release frequency and code quality; and (4) developer experience diversity enhances code review effectiveness.

These findings provide actionable guidance for software development teams and highlight opportunities for future empirical research in software engineering.

\\section*{Acknowledgements}

This work was supported in part by the Science Foundation Ireland grant No. 13/RC/2094\\_P2 and the European Research Council under Grant Agreement No. 741278.

\\bibliographystyle{elsarticle-num}
\\bibliography{references}

\\end{document}
`;
}

// ── Test data setup ─────────────────────────────────────────────────────
async function setupTestData() {
  console.log(`Creating ${NUM_USERS} test users, ${NUM_DOCS} projects/files...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create users
    const userIds = [];
    const sessionIds = [];
    const csrfTokens = [];
    for (let i = 0; i < NUM_USERS; i++) {
      const userId = uuid();
      const sessionId = uuid();
      const csrfToken = crypto.randomBytes(32).toString('hex');
      userIds.push(userId);
      sessionIds.push(sessionId);
      csrfTokens.push(csrfToken);

      // Delete any leftover user with this email first (cascades FKs)
      await client.query(`DELETE FROM users WHERE email = $1`, [`loadtest_user_${i}@test.local`]);
      await client.query(
        `INSERT INTO users (id, email, name, password_hash, email_verified) VALUES ($1, $2, $3, $4, TRUE)`,
        [userId, `loadtest_user_${i}@test.local`, `LoadTest User ${i}`, 'not-a-real-hash'],
      );
      const sess = JSON.stringify({
        cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: '/' },
        userId,
        csrfToken,
      });
      await client.query(
        `INSERT INTO session (sid, sess, expire) VALUES ($1, $2::json, $3)
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sessionId, sess, new Date(Date.now() + 86400000)],
      );
    }

    // Create projects and files
    const projectIds = [];
    const fileIds = [];
    for (let d = 0; d < NUM_DOCS; d++) {
      const projectId = uuid();
      const fileId = uuid();
      projectIds.push(projectId);
      fileIds.push(fileId);

      await client.query(
        `INSERT INTO projects (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [projectId, `LoadTest Project ${d}`],
      );
      await client.query(
        `INSERT INTO files (id, project_id, path, content) VALUES ($1, $2, 'main.tex', $3) ON CONFLICT DO NOTHING`,
        [fileId, projectId, generateDocument(d)],
      );
    }

    // Assign users to projects (round-robin, ~5 users per doc)
    for (let i = 0; i < NUM_USERS; i++) {
      const projectIdx = i % NUM_DOCS;
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`,
        [projectIds[projectIdx], userIds[i]],
      );
    }

    await client.query('COMMIT');
    console.log('Test data created.');
    return { userIds, sessionIds, csrfTokens, projectIds, fileIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cleanupTestData() {
  console.log('Cleaning up test data...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Delete in dependency order
    await client.query(`DELETE FROM session WHERE sid IN (SELECT sid FROM session WHERE (sess::jsonb->>'userId') IN (SELECT id FROM users WHERE email LIKE 'loadtest_user_%@test.local'))`);
    await client.query(`DELETE FROM tracked_changes WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'LoadTest Project %')`);
    await client.query(`DELETE FROM files WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'LoadTest Project %')`);
    await client.query(`DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE name LIKE 'LoadTest Project %')`);
    await client.query(`DELETE FROM projects WHERE name LIKE 'LoadTest Project %'`);
    await client.query(`DELETE FROM users WHERE email LIKE 'loadtest_user_%@test.local'`);
    await client.query('COMMIT');
    console.log('Cleanup done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup error:', err.message);
  } finally {
    client.release();
  }
}

// ── Metrics ─────────────────────────────────────────────────────────────
const metrics = {
  wsConnected: 0,
  wsConnectFailed: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  keystrokesSent: 0,
  latencies: [],       // round-trip if we can measure
  connectLatencies: [],
  compilesStarted: 0,
  compilesSucceeded: 0,
  compilesFailed: 0,
  compilesRateLimited: 0,
  compileLatencies: [],
  startTime: 0,
};

function reportMetrics() {
  const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(1);
  const avgConnectMs = metrics.connectLatencies.length
    ? (metrics.connectLatencies.reduce((a, b) => a + b, 0) / metrics.connectLatencies.length).toFixed(0)
    : 'N/A';
  let line =
    `[${elapsed}s] WS: ${metrics.wsConnected} connected, ${metrics.wsConnectFailed} failed | ` +
    `Messages: ${metrics.messagesSent} sent, ${metrics.messagesReceived} recv | ` +
    `Keystrokes: ${metrics.keystrokesSent} | Errors: ${metrics.errors} | ` +
    `Avg connect: ${avgConnectMs}ms`;
  if (COMPILE_INTERVAL_S > 0) {
    const avgCompileMs = metrics.compileLatencies.length
      ? (metrics.compileLatencies.reduce((a, b) => a + b, 0) / metrics.compileLatencies.length).toFixed(0)
      : 'N/A';
    line += `\n  Compiles: ${metrics.compilesStarted} started, ${metrics.compilesSucceeded} ok, ` +
      `${metrics.compilesFailed} failed, ${metrics.compilesRateLimited} rate-limited | ` +
      `Avg compile: ${avgCompileMs}ms`;
  }
  console.log(line);
}

// ── Simulated user ──────────────────────────────────────────────────────
function createSimulatedUser(userId, sessionId, projectId, fileId, userIndex) {
  return new Promise((resolve) => {
    const signedCookie = signCookie(sessionId);
    const cookieHeader = `__session=${encodeURIComponent(signedCookie)}`;
    const connectStart = Date.now();

    const ws = new WebSocket(WS_URL, {
      headers: { Cookie: cookieHeader, Origin: `https://localhost:${PORT}` },
      rejectUnauthorized: false, // self-signed cert in dev
    });

    let cursorPos = 3000 + Math.floor(Math.random() * 2000); // start typing at a random position in the paper body
    let corpusIdx = 0;
    let charIdx = 0;
    let typingTimer = null;
    let alive = true;

    ws.on('open', () => {
      metrics.connectLatencies.push(Date.now() - connectStart);
      metrics.wsConnected++;
      // Join the project
      ws.send(JSON.stringify({ type: 'join', projectId }));
    });

    ws.on('message', (data) => {
      metrics.messagesReceived++;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'joined') {
          // Start typing after a random initial delay (stagger users)
          const startDelay = Math.random() * 3000;
          setTimeout(() => typeNextChar(), startDelay);
        }
      } catch {}
    });

    function typeNextChar() {
      if (!alive || ws.readyState !== WebSocket.OPEN) return;

      const text = CORPUS[corpusIdx % CORPUS.length];
      const char = text[charIdx];

      // Send a CodeMirror-style change
      const change = { from: cursorPos, insert: char };
      ws.send(JSON.stringify({
        type: 'changes',
        fileId,
        changes: [change],
      }));
      metrics.messagesSent++;
      metrics.keystrokesSent++;
      cursorPos++;
      charIdx++;

      if (charIdx >= text.length) {
        charIdx = 0;
        corpusIdx++;
      }

      // Also send cursor update every ~10 chars
      if (metrics.keystrokesSent % 10 === 0) {
        ws.send(JSON.stringify({
          type: 'cursor',
          fileId,
          head: cursorPos,
          anchor: cursorPos,
        }));
        metrics.messagesSent++;
      }

      typingTimer = setTimeout(typeNextChar, nextKeystrokeDelay());
    }

    ws.on('error', (err) => {
      metrics.errors++;
      if (!metrics.wsConnected && metrics.wsConnectFailed < 3) {
        console.error(`  User ${userIndex} connect error: ${err.message}`);
      }
      metrics.wsConnectFailed++;
    });

    ws.on('close', () => {
      alive = false;
      if (typingTimer) clearTimeout(typingTimer);
    });

    // Return control object
    resolve({
      stop() {
        alive = false;
        if (typingTimer) clearTimeout(typingTimer);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      },
    });
  });
}

// ── DB metrics poller ───────────────────────────────────────────────────
async function pollDbMetrics() {
  try {
    const [connResult, lockResult, txResult] = await Promise.all([
      pool.query(`SELECT count(*) as total, count(*) FILTER (WHERE state = 'active') as active,
                         count(*) FILTER (WHERE state = 'idle') as idle,
                         count(*) FILTER (WHERE wait_event_type = 'Lock') as waiting
                  FROM pg_stat_activity WHERE datname = $1`, [process.env.PGDATABASE || 'flowtex']),
      pool.query(`SELECT count(*) as locks FROM pg_locks WHERE NOT granted`),
      pool.query(`SELECT xact_commit, xact_rollback, tup_inserted, tup_updated, tup_deleted,
                         blks_hit, blks_read
                  FROM pg_stat_database WHERE datname = $1`, [process.env.PGDATABASE || 'flowtex']),
    ]);

    const conn = connResult.rows[0];
    const locks = lockResult.rows[0];
    const tx = txResult.rows[0];

    console.log(
      `  DB: ${conn.total} connections (${conn.active} active, ${conn.idle} idle, ${conn.waiting} waiting) | ` +
      `${locks.locks} blocked locks | ` +
      `commits: ${tx.xact_commit}, rollbacks: ${tx.xact_rollback} | ` +
      `inserts: ${tx.tup_inserted}, updates: ${tx.tup_updated} | ` +
      `cache hit ratio: ${tx.blks_hit && tx.blks_read !== undefined ? ((Number(tx.blks_hit) / (Number(tx.blks_hit) + Number(tx.blks_read) || 1)) * 100).toFixed(1) : 'N/A'}%`,
    );
  } catch (err) {
    console.error(`  DB metrics error: ${err.message}`);
  }
}

// ── Compile scheduler ───────────────────────────────────────────────────
// One compile timer per project. Uses the first user assigned to that project.
function startCompileSchedulers(projectIds, sessionIds, csrfTokens) {
  if (COMPILE_INTERVAL_S <= 0) return [];
  const timers = [];
  for (let d = 0; d < projectIds.length; d++) {
    // Use the first user assigned to this project (user index = d, since round-robin)
    const userSessionId = sessionIds[d];
    const signedCookie = signCookie(userSessionId);
    const cookieHeader = `__session=${encodeURIComponent(signedCookie)}`;
    const csrfToken = csrfTokens[d];
    const projectId = projectIds[d];

    // Jitter ±25%
    const jitter = 0.75 + Math.random() * 0.5;
    const intervalMs = COMPILE_INTERVAL_S * 1000 * jitter;
    // Initial delay: stagger across the interval so they don't all fire at once
    const initialDelay = Math.random() * intervalMs;

    let stopped = false;

    async function doCompile() {
      if (stopped) return;
      metrics.compilesStarted++;
      const start = Date.now();
      try {
        const resp = await fetch(`${BASE_URL}/api/compile/${projectId}`, {
          method: 'POST',
          headers: { Cookie: cookieHeader, 'x-csrf-token': csrfToken },
        });
        const latency = Date.now() - start;
        metrics.compileLatencies.push(latency);
        if (resp.status === 429) {
          metrics.compilesRateLimited++;
        } else if (resp.ok) {
          const body = await resp.json().catch(() => ({}));
          if (body.success) {
            metrics.compilesSucceeded++;
          } else {
            // Compiled but LaTeX had errors (expected — test content isn't valid LaTeX)
            metrics.compilesSucceeded++;
          }
        } else {
          metrics.compilesFailed++;
          if (metrics.compilesFailed <= 3) {
            const text = await resp.text().catch(() => '');
            console.log(`  Compile failed (${resp.status}): ${text.slice(0, 200)}`);
          }
        }
      } catch (err) {
        metrics.compilesFailed++;
      }
      if (!stopped) {
        const nextJitter = 0.75 + Math.random() * 0.5;
        timers.push(setTimeout(doCompile, COMPILE_INTERVAL_S * 1000 * nextJitter));
      }
    }

    const t = setTimeout(doCompile, initialDelay);
    timers.push(t);
    timers.push({ stop() { stopped = true; } });
  }
  return timers;
}

function stopCompileSchedulers(timers) {
  for (const t of timers) {
    if (typeof t === 'object' && t.stop) t.stop();
    else clearTimeout(t);
  }
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== FlowTex Load Test ===`);
  console.log(`Users: ${NUM_USERS} | Documents: ${NUM_DOCS} | Duration: ${DURATION_S}s`);
  if (COMPILE_INTERVAL_S > 0) console.log(`Compile: every ~${COMPILE_INTERVAL_S}s per project`);
  console.log(`Target: ${WS_URL}\n`);

  let testData;
  try {
    testData = await setupTestData();
  } catch (err) {
    console.error('Failed to set up test data:', err.message);
    process.exit(1);
  }

  const { userIds, sessionIds, csrfTokens, projectIds, fileIds } = testData;

  metrics.startTime = Date.now();
  const metricsInterval = setInterval(reportMetrics, 5000);
  const dbMetricsInterval = setInterval(pollDbMetrics, 10000);

  // Snapshot initial DB stats for delta calculation
  let initialDbStats;
  try {
    const r = await pool.query(
      `SELECT xact_commit, xact_rollback, tup_inserted, tup_updated, tup_deleted
       FROM pg_stat_database WHERE datname = $1`,
      [process.env.PGDATABASE || 'flowtex'],
    );
    initialDbStats = r.rows[0];
  } catch {}

  // Ramp up connections over 30 seconds to avoid thundering herd
  console.log('Ramping up connections...');
  const users = [];
  const rampDuration = Math.min(30000, DURATION_S * 1000 * 0.25);
  const rampDelay = rampDuration / NUM_USERS;

  for (let i = 0; i < NUM_USERS; i++) {
    const projectIdx = i % NUM_DOCS;
    const userHandle = await createSimulatedUser(
      userIds[i], sessionIds[i], projectIds[projectIdx], fileIds[projectIdx], i,
    );
    users.push(userHandle);

    if (rampDelay > 1) await sleep(rampDelay);

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${NUM_USERS} users connected`);
    }
  }

  console.log(`\nAll ${NUM_USERS} users connected. Running for ${DURATION_S}s...\n`);
  reportMetrics();
  await pollDbMetrics();

  // Start compile schedulers if enabled
  const compileTimers = startCompileSchedulers(projectIds, sessionIds, csrfTokens);
  if (COMPILE_INTERVAL_S > 0) {
    console.log(`Started compile schedulers for ${NUM_DOCS} projects (every ~${COMPILE_INTERVAL_S}s)\n`);
  }

  // Wait for the test duration
  await sleep(DURATION_S * 1000);

  // Stop all users and compiles
  console.log('\nStopping simulated users...');
  stopCompileSchedulers(compileTimers);
  for (const u of users) u.stop();
  await sleep(2000); // let connections close

  clearInterval(metricsInterval);
  clearInterval(dbMetricsInterval);

  // Final report
  console.log('\n=== Final Results ===');
  reportMetrics();
  await pollDbMetrics();

  // Delta DB stats
  if (initialDbStats) {
    try {
      const r = await pool.query(
        `SELECT xact_commit, xact_rollback, tup_inserted, tup_updated, tup_deleted
         FROM pg_stat_database WHERE datname = $1`,
        [process.env.PGDATABASE || 'flowtex'],
      );
      const final = r.rows[0];
      const elapsed = (Date.now() - metrics.startTime) / 1000;
      const dCommits = Number(final.xact_commit) - Number(initialDbStats.xact_commit);
      const dRollbacks = Number(final.xact_rollback) - Number(initialDbStats.xact_rollback);
      const dInserts = Number(final.tup_inserted) - Number(initialDbStats.tup_inserted);
      const dUpdates = Number(final.tup_updated) - Number(initialDbStats.tup_updated);
      console.log(
        `\n  DB totals during test: ${dCommits} commits (${(dCommits / elapsed).toFixed(0)}/s), ` +
        `${dRollbacks} rollbacks, ${dInserts} inserts, ${dUpdates} updates`,
      );
    } catch {}
  }

  const totalKeystrokesPerSec = (metrics.keystrokesSent / ((Date.now() - metrics.startTime) / 1000)).toFixed(1);
  console.log(`  Keystroke throughput: ${totalKeystrokesPerSec} keystrokes/sec across ${NUM_USERS} users`);
  console.log(`  Avg connect latency: ${metrics.connectLatencies.length ? (metrics.connectLatencies.reduce((a, b) => a + b, 0) / metrics.connectLatencies.length).toFixed(0) : 'N/A'}ms`);

  // Cleanup
  await cleanupTestData();
  await pool.end();

  console.log('\nLoad test complete.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
