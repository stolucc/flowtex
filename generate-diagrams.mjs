import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'docs');

const shared = `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    padding: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  h1 { font-size: 40px; font-weight: 700; color: #e6edf3; letter-spacing: -0.5px; }
  h2 { font-size: 18px; font-weight: 400; color: #8b949e; margin-top: 6px; margin-bottom: 40px; }
  .card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 12px;
    padding: 48px;
    width: fit-content;
    max-width: 100%;
  }
  .mermaid { display: flex; justify-content: center; }
  .mermaid svg { max-width: 100%; }
  .legend {
    display: flex; gap: 24px; margin-top: 24px; justify-content: center; flex-wrap: wrap;
  }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 15px; color: #8b949e; }
  .legend-dot { width: 14px; height: 14px; border-radius: 3px; }
</style>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({
    startOnLoad: true,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#161b22',
      primaryColor: '#1f6feb',
      primaryTextColor: '#e6edf3',
      primaryBorderColor: '#388bfd',
      secondaryColor: '#238636',
      secondaryTextColor: '#e6edf3',
      secondaryBorderColor: '#2ea043',
      tertiaryColor: '#6e40c9',
      tertiaryTextColor: '#e6edf3',
      tertiaryBorderColor: '#8957e5',
      lineColor: '#484f58',
      textColor: '#c9d1d9',
      mainBkg: '#1f6feb',
      nodeBorder: '#388bfd',
      clusterBkg: '#21262d',
      clusterBorder: '#30363d',
      titleColor: '#e6edf3',
      edgeLabelBackground: '#161b22',
      fontSize: '16px',
    },
    flowchart: { curve: 'basis', padding: 24, htmlLabels: true, useMaxWidth: false },
    er: { useMaxWidth: false, fontSize: 14 },
  });
</script>
`;

const diagrams = [
  {
    name: 'architecture',
    title: 'FlowTex',
    subtitle: 'System Architecture',
    legend: [
      { color: '#1f6feb', label: 'Client / Components' },
      { color: '#238636', label: 'Server / Routes' },
      { color: '#6e40c9', label: 'Data Storage' },
      { color: '#b62324', label: 'External Services' },
    ],
    mermaid: `flowchart TB
  classDef client fill:#1f6feb,stroke:#388bfd,color:#fff,rx:8,ry:8
  classDef server fill:#238636,stroke:#2ea043,color:#fff,rx:8,ry:8
  classDef storage fill:#6e40c9,stroke:#8957e5,color:#fff,rx:8,ry:8
  classDef external fill:#b62324,stroke:#da3633,color:#fff,rx:8,ry:8
  classDef route fill:#1a7f37,stroke:#2ea043,color:#e6edf3,rx:6,ry:6
  classDef util fill:#553098,stroke:#8957e5,color:#e6edf3,rx:6,ry:6
  classDef component fill:#0550ae,stroke:#388bfd,color:#e6edf3,rx:6,ry:6

  subgraph Browser["Browser Client &mdash; React + Vite"]
    direction TB
    App["<b>App.jsx</b><br/>Routing &middot; State &middot; WebSocket"]:::component
    subgraph Components["UI Components"]
      direction LR
      Editor["<b>Editor</b><br/>CodeMirror 6"]:::component
      PdfViewer["<b>PdfViewer</b><br/>PDF Preview"]:::component
      Toolbar["<b>Toolbar</b><br/>Menu Bar"]:::component
      FileTree["<b>FileTree</b><br/>File Browser"]:::component
    end
    subgraph Panels["Feature Panels"]
      direction LR
      Chat["ChatPanel"]:::component
      Comments["CommentsSidebar"]:::component
      History["HistoryPanel"]:::component
      GitSync["GitHubSyncModal"]:::component
    end
    subgraph ClientUtils["Client Utilities"]
      direction LR
      Parser["latexParser"]:::component
      Spell["spellcheck"]:::component
      Lint["latexLint"]:::component
    end
    App --> Components
    App --> Panels
    Editor --> ClientUtils
  end

  subgraph Server["Express.js Server &mdash; Node.js"]
    direction TB
    Index["<b>index.js</b><br/>HTTP + WebSocket"]:::server
    subgraph Routes["REST API Routes"]
      direction LR
      AuthRoute["<b>auth</b><br/>Login &middot; Register &middot; 2FA"]:::route
      ProjectRoute["<b>projects</b><br/>CRUD &middot; Share"]:::route
      CompileRoute["<b>compile</b><br/>Build &middot; SyncTeX"]:::route
      GHRoute["<b>github</b><br/>OAuth &middot; Sync"]:::route
      BibRoute["<b>bib / zotero</b><br/>Bibliography"]:::route
      OtherRoutes["<b>history / tags</b><br/>comments &middot; admin"]:::route
    end
    subgraph Utils["Server Utilities"]
      direction LR
      Crypto["<b>crypto</b><br/>AES-256-GCM"]:::util
      GitSyncUtil["<b>gitSync</b><br/>Git Operations"]:::util
      LatexDiff["<b>latexDiff</b>"]:::util
      Email["<b>email</b>"]:::util
      Audit["<b>audit</b>"]:::util
    end
    Index --> Routes
    Routes --> Utils
  end

  subgraph Data["Data Layer"]
    direction LR
    PG[("PostgreSQL<br/>Users &middot; Projects<br/>Files &middot; Sessions")]:::storage
    Disk[("Disk Storage<br/>/projects/<br/>TeX &middot; PDFs")]:::storage
    Redis[("Redis<br/>WS Scaling")]:::storage
  end

  subgraph External["External Services"]
    direction LR
    GitHub["GitHub API"]:::external
    TexLive["TeX Live<br/>latexmk &middot; pdflatex"]:::external
    Zotero["Zotero API"]:::external
  end

  Browser -- "HTTP REST" --> Server
  Browser -- "WebSocket<br/>real-time" --> Index
  CompileRoute -- "execFile" --> TexLive
  GHRoute --> GitSyncUtil
  GitSyncUtil -- "simple-git" --> GitHub
  BibRoute --> Zotero
  Routes --> PG
  CompileRoute --> Disk
  GitSyncUtil --> Disk
  Editor -- "SyncTeX" --> PdfViewer
  Index --> PG
  Index -.-> Redis`,
  },
  {
    name: 'pipeline',
    title: 'FlowTex',
    subtitle: 'Compilation Pipeline & Real-time Collaboration',
    legend: [
      { color: '#1f6feb', label: 'User Action' },
      { color: '#238636', label: 'Data / Process' },
      { color: '#6e40c9', label: 'Output' },
      { color: '#b62324', label: 'WebSocket' },
    ],
    mermaid: `flowchart LR
  classDef action fill:#1f6feb,stroke:#388bfd,color:#fff,rx:8,ry:8
  classDef data fill:#238636,stroke:#2ea043,color:#fff,rx:8,ry:8
  classDef result fill:#6e40c9,stroke:#8957e5,color:#fff,rx:8,ry:8
  classDef ws fill:#b62324,stroke:#da3633,color:#fff,rx:8,ry:8

  subgraph Compile["Compilation Pipeline"]
    direction LR
    Edit["Edit in<br/>CodeMirror"]:::action
    SyncDisk["Sync files<br/>to disk"]:::data
    Latexmk["latexmk -pdf<br/>sandboxed"]:::data
    PDF["PDF with<br/>SyncTeX"]:::result
    SSE["SSE log<br/>stream"]:::data
    Viewer["PDF Viewer<br/>updates"]:::result
    Edit --> SyncDisk --> Latexmk --> PDF --> Viewer
    Latexmk --> SSE
  end

  subgraph GitHubSync["GitHub Sync"]
    direction LR
    PushBtn["Push"]:::action
    AutoPush["Auto-push<br/>every 5 min"]:::action
    LocalGit["Local Git<br/>Repo"]:::data
    Remote["GitHub<br/>Remote"]:::result
    PullBtn["Pull"]:::action
    AutoPush --> PushBtn
    PushBtn --> LocalGit --> Remote
    Remote --> LocalGit
    LocalGit --> PullBtn
  end

  subgraph Collab["Real-time Collaboration"]
    direction LR
    UserA["User A"]:::action
    WSServer["WebSocket<br/>Server"]:::ws
    UserB["User B"]:::action
    Edits["Document<br/>edits"]:::data
    Cursors["Cursor<br/>positions"]:::data
    ChatMsg["Chat<br/>messages"]:::data
    TC["Track<br/>changes"]:::data
    UserA --> WSServer --> UserB
    WSServer --- Edits
    WSServer --- Cursors
    WSServer --- ChatMsg
    WSServer --- TC
  end`,
  },
  {
    name: 'database',
    title: 'FlowTex',
    subtitle: 'Database Schema &mdash; 22 PostgreSQL Tables',
    legend: [],
    mermaid: `erDiagram
    users {
        varchar id PK
        varchar email UK
        varchar name
        varchar password_hash
        varchar totp_secret
        boolean totp_enabled
        boolean is_admin
        timestamp created_at
    }
    projects {
        varchar id PK
        varchar name
        varchar main_file
        boolean archived
        boolean trashed
        integer snapshot_interval
        timestamp created_at
        timestamp updated_at
    }
    files {
        varchar id PK
        varchar project_id FK
        varchar path
        varchar content
        boolean is_binary
        timestamp created_at
    }
    file_versions {
        varchar id PK
        varchar file_id FK
        varchar project_id FK
        varchar file_path
        varchar author_id FK
        varchar author_name
        timestamp created_at
    }
    project_members {
        varchar project_id PK
        varchar user_id FK
        varchar role
        timestamp created_at
    }
    project_invitations {
        varchar id PK
        varchar project_id FK
        varchar email UK
        varchar inviter_id FK
        varchar role
        varchar status
    }
    project_snapshots {
        varchar id PK
        varchar project_id FK
        varchar author_id
        varchar author_name
        varchar label
        timestamp created_at
    }
    comments {
        varchar id PK
        varchar file_id FK
        integer from_pos
        integer to_pos
        varchar body
        varchar author_id FK
        boolean resolved
        timestamp created_at
    }
    comment_replies {
        varchar id PK
        varchar comment_id FK
        varchar body
        varchar author_id FK
        timestamp created_at
    }
    chat_messages {
        varchar id PK
        varchar project_id FK
        varchar user_id FK
        varchar user_name
        varchar body
        timestamp created_at
    }
    tracked_changes {
        varchar id PK
        varchar file_id FK
        varchar project_id FK
        integer from_pos
        integer to_pos
        varchar inserted
        varchar deleted
        varchar author_id FK
        varchar status
        varchar resolved_by FK
    }
    tags {
        varchar id PK
        varchar user_id FK
        varchar name UK
        varchar color
    }
    project_tags {
        varchar project_id PK
        varchar tag_id FK
    }
    github_tokens {
        varchar user_id PK
        varchar token
        timestamp updated_at
    }
    project_github_links {
        varchar project_id PK
        varchar github_repo
        varchar default_branch
        boolean auto_push
        varchar linked_by FK
        timestamp last_sync_at
    }
    zotero_tokens {
        varchar user_id PK
        varchar api_key
        varchar zotero_user_id
    }
    session {
        varchar sid PK
        json sess
        timestamp expire
    }
    audit_log {
        integer id PK
        varchar user_id
        varchar action
        varchar target_type
        varchar target_id
        varchar ip
        timestamp created_at
    }
    login_attempts {
        integer id PK
        varchar email
        varchar ip
        boolean success
        timestamp created_at
    }
    password_reset_tokens {
        varchar id PK
        varchar user_id FK
        varchar token_hash
        boolean used
        timestamp expires_at
    }
    trusted_devices {
        varchar id PK
        varchar user_id FK
        varchar token_hash
        varchar device_name
        timestamp expires_at
    }
    used_totp_codes {
        varchar user_id PK
        varchar code
        timestamp expires_at
    }

    users ||--o{ project_members : members
    projects ||--o{ project_members : members
    projects ||--o{ files : contains
    files ||--o{ file_versions : versions
    projects ||--o{ file_versions : versions
    projects ||--o{ project_snapshots : snapshots
    files ||--o{ comments : has
    comments ||--o{ comment_replies : has
    users ||--o{ comments : writes
    users ||--o{ comment_replies : writes
    projects ||--o{ chat_messages : has
    users ||--o{ chat_messages : sends
    files ||--o{ tracked_changes : has
    projects ||--o{ tracked_changes : has
    users ||--o{ tracked_changes : writes
    users ||--o{ tags : creates
    projects ||--o{ project_tags : has
    tags ||--o{ project_tags : has
    projects ||--o{ project_invitations : has
    users ||--o{ project_invitations : sends
    users ||--o| github_tokens : has
    projects ||--o| project_github_links : has
    users ||--o| zotero_tokens : has
    users ||--o{ password_reset_tokens : has
    users ||--o{ trusted_devices : has
    users ||--o{ used_totp_codes : has`,
  },
];

async function main() {
  const browser = await chromium.launch();

  for (const d of diagrams) {
    console.log(`Rendering ${d.name}...`);

    const legendHtml = d.legend.length
      ? `<div class="legend">${d.legend.map(l => `<div class="legend-item"><div class="legend-dot" style="background:${l.color}"></div>${l.label}</div>`).join('')}</div>`
      : '';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">${shared}</head><body>
      <h1>${d.title}</h1>
      <h2>${d.subtitle}</h2>
      <div class="card">
        <pre class="mermaid">${d.mermaid}</pre>
        ${legendHtml}
      </div>
    </body></html>`;

    const page = await browser.newPage({ viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    // Wait for mermaid to render
    await page.waitForSelector('.mermaid svg', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // Size viewport to content
    const box = await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      const body = document.body;
      return { width: body.scrollWidth + 96, height: body.scrollHeight + 96 };
    });
    await page.setViewportSize({ width: Math.max(box.width, 1200), height: Math.max(box.height, 800) });
    await page.waitForTimeout(500);

    const outPath = path.join(outDir, `${d.name}.png`);
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`  -> ${outPath}`);
    await page.close();
  }

  await browser.close();
  console.log('Done!');
}

main().catch(err => { console.error(err); process.exit(1); });
