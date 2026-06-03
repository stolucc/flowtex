# FlowTex User Guide

## Getting Started

### Creating an Account

1. Open FlowTex in your browser
2. Click **Register** and fill in your name, email, and password
   - Password must be at least 8 characters with uppercase, lowercase, and a number
3. You'll be logged in automatically after registration

### Logging In

1. Enter your email and password
2. If you have two-factor authentication enabled, enter the 6-digit code from your authenticator app
3. Sessions last 7 days — you won't need to log in again unless you log out

---

## Dashboard

After logging in, you'll see the **Project List** dashboard.

### Creating a Project

- Click the **New Project** button in the top-left
- Enter a project name and click Create
- A new project is created with a starter `main.tex` template

### Opening a Project

- Click any project row to open it in the editor

### Managing Projects

- **Rename**: Click the project name (in the editor toolbar or dashboard) or use **Project → Rename Project…** from the editor menu
- **Delete**: Click the trash icon (owner only) — this permanently deletes the project and all files
- **Archive/Trash**: Use the project menu for soft archiving

### Tags

- Create colored tags to organize your projects
- Click the tag icon next to a project to assign/remove tags
- Filter the project list by clicking a tag in the sidebar

### Invitations

- Pending invitations from other users appear at the top of the dashboard
- Click **Accept** to join a project or **Decline** to dismiss

---

## The Editor

The editor view has four main areas arranged left to right:

```text
+----------------------------------------------------------+
|                       Toolbar                             |
+----------+------------------+----+----------+-------------+
|          |                  |    |          |              |
|   File   |     LaTeX        |Sync|   PDF    |  Comments   |
|   Tree   |     Editor       |    |  Viewer  |  Sidebar    |
|          |                  |    |          |              |
+----------+------------------+----+----------+-------------+
```

All panels are resizable — drag the borders between them.

### File Tree (Left Panel)

- **Create file**: Click the "+" icon at the top, or right-click for a context menu
- **Create folder**: Click the folder "+" icon
- **Rename**: Double-click a file name, or right-click > Rename
- **Delete**: Right-click > Delete (with confirmation)
- **Set main file**: Right-click a `.tex` file > Set as Main File — this is the file that gets compiled. **Any project member can change the main file** (as well as the compiler and TeX distribution under Project Settings); these are shared compile choices, not owner-only settings. Only the project *name* and snapshot interval remain owner-only
- **Upload ZIP**: Use the toolbar menu to upload a ZIP archive of files

### LaTeX Editor (Center)

The editor provides a full-featured LaTeX editing experience:

- **Syntax highlighting** for LaTeX commands, environments, math, and comments
- **Autocomplete**: Type `\` to see LaTeX command suggestions, or start a `\begin{` for environment completion. Citation keys (from your `.bib` files) and reference labels are also offered after `\cite{` and `\ref{`.
- **Bracket matching**: Matching braces, brackets, and parentheses are highlighted
- **Search & replace**: Use `Cmd/Ctrl+F` to find, `Cmd/Ctrl+H` to replace
- **Multiple cursors**: `Cmd/Ctrl+D` to select next occurrence
- **Line numbers**: Shown in the gutter
- **Spellcheck**: Misspelled words are underlined — right-click for suggestions
- **Lint diagnostics**: Syntax issues from LaCheck appear as warnings in the gutter
- **Citation hover**: Hover over any `\cite{key}` to see authors, year, title, and venue (booktitle / journal / publisher) pulled from your project's `.bib` files

### Visual Mode (WYSIWYG)

Toggle Visual Mode from the **View** menu (or `Cmd/Ctrl+Shift+V`) to switch the editor from raw LaTeX source to a rendered preview that still lets you edit the underlying text:

- Bold, italic, underlined, monospace, and small-caps text render with their formatting; the surrounding `\textbf{...}` markup is hidden but never deleted from the source.
- Section, subsection, and chapter headings render as styled headings.
- `\begin{itemize}` / `\begin{enumerate}` show as bulleted / numbered lists; `\begin{quote}` becomes an indented block.
- `\cite{...}` and `\ref{...}` appear as small badges. Hover for full bibliographic details; click to jump to the source.
- The preamble (everything before `\begin{document}`) and `\end{document}` are hidden so you can focus on content.
- A floating toolbar appears with bold/italic, headings, lists, quote, and citation insertion buttons.

Visual mode is purely visual — toggling it off restores the exact same source. Type, paste, undo/redo, and collaborate as you normally would.

### Compiling

1. Click the **Compile** button in the toolbar (or use `Cmd/Ctrl+Enter`)
2. Compilation output streams in real-time in the console panel below the PDF
3. When complete, the PDF updates automatically
4. If compilation fails, errors and warnings are shown with clickable file/line references

**Stop compilation**: Click the stop button if a compilation is taking too long.

**Clean auxiliary files**: Use the toolbar menu > Clean to remove `.aux`, `.log`, `.bbl`, and other generated files. Useful if compilation gets stuck.

### PDF Viewer (Right Panel)

- **Zoom**: Use the zoom slider, `+`/`-` buttons, or `Cmd/Ctrl+scroll`
- **Page navigation**: Scroll through pages, or use page up/down
- **Forward sync** (editor to PDF): Click the right arrow between editor and PDF — jumps the PDF to the location corresponding to your cursor
- **Inverse sync** (PDF to editor): Double-click a location in the PDF — jumps the editor to the corresponding source line
- **Errors / warnings**: Two icon chips at the top of the PDF panel — a red ⊗ and an amber ▲ — show the live count from the LaTeX log plus the linter. Click either to expand a panel listing each diagnostic with a clickable file/line reference. The icons turn muted when there are zero, and red/amber when there's something to look at.
- **Console**: Toggle to see full compilation output

### Comments Sidebar (Far Right)

- **Add a comment**: Select text in the editor, then click the comment icon that appears, or use the toolbar
- **Reply**: Click a comment to expand it, then type a reply
- **Resolve**: Click the checkmark to resolve a comment thread
- **Edit/Delete**: Use the menu on your own comments to edit or delete them
- **@-mention a collaborator**: Type `@` while composing a comment or reply — an autocomplete popover lists project members. Pick one and the mention is inserted as `@Name` (or `@"Full Name"` for multi-word names). Mentioned users get an in-app notification immediately (see the bell in the toolbar) and an emailed digest if they aren't online.
- **Assign a comment**: When you @-mention someone, an "Assign to" checkbox appears — tick it to mark the comment as assigned to that person; their name shows in a banner above the comment. The assignee always receives both the bell notification and an entry in the next digest email **even when you assign the comment to yourself** (useful when you're tracking your own to-do items on a manuscript).
- **React with emoji**: Hover any comment or reply and click the ☺ trigger that appears in the bottom-right; pick from the palette (👍 ❤️ 😄 🎉 🤔 👀 ✅ ❌). Reactions appear as pills under the comment; click a pill you've placed to remove it. All collaborators see the same reaction set in real time.
- Comments are positioned alongside the relevant lines in the editor.
- **Collapsed rail**: Close the comments panel (its close button) and the thin remaining strip on the right edge keeps showing a small speech-bubble icon at each unresolved comment's y-position, so you can see where threads live without re-opening the panel. Click the strip to re-open.

### Notifications (Bell)

The bell icon in the toolbar shows the count of unread @-mentions. Click it to see recent mentions (up to 50, kept 7 days after being seen), each linking back to its project.

**Clicking a notification deep-links you to the exact comment.** The handler walks the necessary state changes in order: switches to the right project (if it's not the one you're in), waits for the file list to load, opens the file the comment lives in, then scrolls the editor to the commented range. The comments sidebar follows because its positioning already tracks the editor scroll, so the comment ends up centered and ready to reply to. If the file or the comment was deleted in the meantime, the click is a quiet no-op rather than spinning forever. "Mark all read" is one click.

If you're offline (or close the tab) when somebody mentions you, a digest email is sent within ~5 minutes covering everyone who mentioned you across all your projects — assuming the server has SMTP configured. The new email layout is a Google-Docs-style card with a clear CTA button that drops you straight back into the conversation.

### Reporting a Bug

Help → **Report a bug** opens a small modal:

1. Describe what went wrong (up to 10,000 characters).
2. Tick one or more feature-area boxes (Editor, Compile / PDF viewer, Track changes, Comments, Notifications, Chat, Real-time collaboration, File management, Visual mode, GitHub sync, BibTeX / Zotero, DOCX import, Project copy / sharing, Account settings / MFA, Admin dashboard, or Something else).
3. Send.

The report is emailed to every admin on the server, with your name and email address attached so they can follow up. There's a soft limit of 5 reports per hour per user to keep the admin inbox sane. The modal has no "X" close button — use **Cancel** or click outside the modal to dismiss it.

---

## Tracked Changes

Word-style change tracking for review workflows.

- **Enable**: Toggle Track Changes from the toolbar (or via the View menu). Once on, every insertion you make is underlined in your accent color, and every deletion stays visible with a strikethrough rather than disappearing.
- **Per-user attribution**: Each tracked change records the author. Hovering a change shows who made it.
- **Review walkthrough**: Click the review eye icon to step through each pending change in order — accept (✓) or reject (✗) one at a time, or accept-all / reject-all from the menu.
- **Diff PDF**: From File ▸ Compare, pick two snapshots (or two states of the same file) and FlowTex will compile a `latexdiff` PDF showing additions / deletions visually side-by-side with the rest of the document.
- **Behavior under file switch**: Pending changes follow the file they belong to — switching files mid-edit won't move a change to a different file.

---

## Real-Time Collaboration

FlowTex supports multiple users editing the same project simultaneously.

### How It Works

- When you open a project, you automatically join the collaboration session
- Other users' cursors appear in the editor with their name labels
- Changes sync in real-time — you'll see edits as they happen
- The presence indicator in the toolbar shows who's currently online

### Sharing a Project

1. Click the **Share** button in the toolbar
2. Enter the email address of the person you want to invite
3. Choose their role:
   - **Editor**: Can edit files and compile
   - **Viewer**: Can view files and PDF but cannot edit
4. Click **Invite** — they'll see the invitation on their dashboard
5. You can change roles or remove members at any time (owner only)

The member list, the avatar bar, and the @-mention autocomplete refresh **live** when someone accepts an invitation or is removed — no page reload needed.

### Copying a Project

From the project list, the project menu has a **Copy** option. If the project has collaborators other than yourself, a small modal opens first so you can:

- Rename the copy (defaults to "Copy of …").
- Optionally **share with the N other collaborators on the original** — when ticked, every non-caller member is added to the copy with their original role. (Solo projects skip this step and copy directly.)

The copy includes:

- All files (text and binary) with the same paths and content
- The tracked-changes sidecar (pending insert / delete ranges and their author attributions), so a review-in-progress survives the duplication
- All inline comments, replies, and emoji reactions on those comments and replies
- The original's compile settings: `compiler` (`pdflatex` / `xelatex` / `lualatex`), `tex_distribution`, the main-file pointer, and the snapshot interval

The copy does **not** include the @-mention notification log (so old mentions don't re-fire emails). Assignment metadata on comments is preserved as-is — if the assignee is later invited to the copy, the assignment lights up again.

To re-share an existing project via copy you must be an editor or owner of the source; viewers can still clone the project for themselves but cannot rebroadcast it to the source's members. Every member added through copy is recorded in the audit log.

### Per-Project Chat

Open the chat panel from View → Chat. Messages are scoped to the current project and visible to all members. The chat has:

- Date separators and per-author bubbles
- A live typing indicator while others are composing
- Emoji reactions (same palette as comments — click the ☺ trigger on hover)
- An unread badge in the toolbar when new messages arrive while the panel is closed
- **Read receipts** on your own messages — `✓` (grey) when at least one other collaborator has read it, `✓✓` (accent colour) when every other member has. Hover the tick to see who specifically has read ("Read by Alice, Bob"). The receipt updates live as others open their chat panel; opening the chat panel marks it read for you (server tracks one "last read" cursor per (project, user))

---

## Version History

FlowTex automatically saves versions of your files as you work.

### Viewing History

1. Click the **History** button in the toolbar or sidebar
2. The history panel shows a timeline of changes for the current file
3. Click any version to see its content
4. Use **Diff** mode to see what changed between two versions (additions in green, deletions in red)

### Restoring a Version

1. Select the version you want to restore
2. Click **Restore** — the file content is replaced with the selected version
3. A new version is created automatically so you don't lose the current content

---

## Importing a Word document (DOCX → LaTeX)

From the project list, the **New Project** menu has an **Import from .docx** option. Drag in a `.docx` and pick a document type — the choice changes which document class FlowTex generates and how Word's heading levels map to LaTeX sectioning commands:

| Document type | Class | Heading 1 → | Notes |
| --- | --- | --- | --- |
| Book / Thesis | `book` | `\chapter` | `\frontmatter` / `\mainmatter` split, `openany`, single-sided, suppressed running headers |
| Report | `report` | `\chapter` | Single-sided by default; same chapter mapping as Book |
| Journal paper | `article` | `\section` | Section-first numbering |
| Conference paper | `article` | `\section` | Section-first numbering |
| Generic | `article` | `\section` | Use when none of the above fits |

The generated `.tex` is intentionally minimal: `\documentclass`, `geometry` margins, `setspace` (only if the source was one-and-a-half- or double-spaced), `graphicx`, `caption`, and `hyperref` / `ulem` / etc. *only* when the body actually needs them. Headings are emitted as bare `\section{Title}` (no `titlesec`, `xcolor`, or custom `\titleformat`), so the output reads like clean hand-written LaTeX and compiles under either `pdflatex` or `xelatex`.

Named Word styles are picked up: `BlockQuote` / `IntenseQuote` / `PullQuote` / `Quotation` / `Aside` / `Epigraph` become `\begin{quote}…`, `Verse` / `Poetry` / `Poem` become `\begin{verse}`, and `Code` / `CodeBlock` / `Listing` / `Preformatted` / `Verbatim` become `\begin{verbatim}` (inline LaTeX is stripped from code blocks before emission because `verbatim` can't nest).

Embedded media is extracted and converted: SVG via `rsvg-convert`, GIF/TIFF/BMP via ImageMagick, WMF/EMF via headless LibreOffice. Proprietary fonts (Helvetica, Times, Palatino, etc.) are aliased to the metric-compatible TeX Gyre family so `xelatex` finds them without a system install.

---

## File Comparison (latexdiff)

Compare two `.tex` files to see additions and deletions rendered in the compiled PDF.

1. Open the **Compare** option from the toolbar menu
2. Select the old file and the new file
3. Click **Compare** — FlowTex runs `latexdiff` and compiles the result
4. The diff PDF shows additions in blue and deletions in red (strikethrough)

---

## GitHub Integration

Link your project to a GitHub repository for backup and version control.

### Setup

1. Open the **GitHub** option from the toolbar menu
2. Enter your GitHub Personal Access Token (PAT)
   - Generate one at github.com > Settings > Developer settings > Personal access tokens
   - Required scope: `repo`
   - Your token is encrypted at rest on the server
3. Enter the repository in `owner/repo` format (e.g., `myuser/my-thesis`)
4. Choose a branch (default: `main`)
5. Click **Link**

### Push to GitHub

1. Click **Push** in the GitHub sync modal
2. Enter a commit message (optional — defaults to "Update from FlowTex")
3. All project files are committed and pushed to the linked branch

### Pull from GitHub

1. Click **Pull** in the GitHub sync modal
2. The latest files from the remote branch are downloaded and synced to your project
3. Conflicting files use the remote version (theirs strategy)

### Unlink

- Click **Unlink** to disconnect the project from GitHub (your token remains stored)

---

## Local LaTeX Compile (opt-in)

By default every compile runs on the FlowTex server. If the server has `FEATURE_LOCAL_COMPILE=1` you can install a small helper on your own machine and have FlowTex compile there instead — faster turnaround, your source never leaves your laptop, and you can pick which TeX Live release runs.

### Install (macOS)

1. **Account Settings → Compile** — the panel walks you through it. Click **Download FlowTex Helper.dmg (arm64 or amd64)**.
2. Open the `.dmg`, drag **FlowTex Helper** to **Applications**.
3. Right-click → **Open** the first time so Gatekeeper asks (the binary is ad-hoc signed but not notarised).
4. Look for the **fTx** label in the menu bar — it's the helper. Click → **Generate pairing code**: a native dialog shows a 6-digit code AND copies it to the clipboard.
5. Back in Account Settings → Compile, paste the code.

That's it. The badge turns green ("Paired. TeX Live YYYY") and your subsequent compiles run on your laptop.

The menu bar also has:

- **Open FlowTex pairing page** — opens `flowtex.click` in your browser.
- **About FlowTex Helper** — shows the helper's version and build SHA so you know what's running.
- **Default TeX Live** — if you have multiple `/usr/local/texlive/YYYY` installs, pick which year is the default for compiles that don't pin a year.
- **Quit** — stops the helper.

### Install (Windows)

1. Download **flowtex-helper-windows-amd64.exe** from the latest [GitHub Release](https://github.com/stolucc/flowtex/releases).
2. Move it somewhere stable (e.g. `C:\Program Files\FlowTex\flowtex-helper.exe`).
3. Double-click to launch. SmartScreen will warn the first time because the .exe isn't code-signed — click **More info** → **Run anyway**.
4. The **fTx** icon appears in the system tray (bottom-right notification area). Click it → **Generate pairing code**, then paste the code into Account Settings → Compile.
5. To auto-start at login, drop a shortcut into `%AppData%\Microsoft\Windows\Start Menu\Programs\Startup`.

The helper applies Windows-specific protections automatically: the config file at `%USERPROFILE%\.flowtex-helper\config.json` (which holds the bearer token) is locked down via `icacls` so other local accounts can't read it. A startup warning fires if `%USERPROFILE%` is on a network share.

### Install (Linux)

The same one-liner from the in-app instructions installs the headless binary on your `$PATH`:

```bash
curl -sSL https://github.com/stolucc/flowtex/releases/latest/download/install.sh | bash
```

Then run `flowtex-helper` and follow the same pair flow. The install script verifies the GitHub Release's SHA256SUMS before installing; if the checksum file is unreachable it refuses to proceed (override with `FLOWTEX_HELPER_SKIP_CHECKSUM=1`).

To keep the helper running across reboots, register a `systemd --user` unit — see `helper/README.md`.

### Pick where each project compiles

Under **Project Settings → Compiler tab**:

- **Compile location for this project** — radio: "Use my default", "Always FlowTex server", or "Always my local TeX Live".
- **TeX Live Distribution** — picks the year. The list filters to whichever side will actually compile (server vs. local) so you can't pin a year that's only on the other side. The "Latest available — YYYY" entry shows you exactly which year the default will resolve to.

### When the helper isn't there

If you set "local" but the helper is offline, busy, or doesn't have the requested TeX Live year, FlowTex transparently falls back to the server. You'll see a brief "Compiling on the FlowTex server" line in the console. No manual switch needed.

---

## Local LLM Writing Assistant (opt-in)

Once the helper is paired and a local [Ollama](https://ollama.com/) runtime is running, you can right-click any selected text in the editor for five LLM-driven actions. All inference happens on YOUR machine — selected text and generated output never traverse the FlowTex server.

### LLM setup

1. Install Ollama: download from [ollama.com](https://ollama.com/) and run.
1. Pull at least one model in a terminal:

   ```bash
   ollama pull llama3.2:3b      # ~2 GB, fast on most hardware
   # or
   ollama pull qwen2.5:7b       # ~5 GB, better at writing
   ```

1. Hard-refresh FlowTex. The helper's tray icon now shows **Local LLM: ● N models**.
1. Open **Help → Helper setup guide** if anything's not lighting up; the dialog runs three live probes (`/health`, `/version`, `/llm/status`) and tells you exactly which step is stuck.

### Using LLM actions

Select text in the editor → right-click → pick an action:

- **Write to length…** — rewrite the selection to approximately N words (counts rendered prose, not LaTeX commands like `\cite{}` or `\textbf{}`).
- **Paraphrase** — reword with similar length, same tone, same LaTeX markup.
- **Itemize** — convert prose into a LaTeX `\begin{itemize}` environment.
- **Write it out** — inverse of itemize: bullets back to a flowing prose paragraph.
- **Other…** — free-form instruction in a textarea ("translate to French", "make this sound more formal"). The model is hard-locked to textual transformations only — instructions like "delete files" or "run a command" are refused. Capped at 1000 characters.

The dialog streams the model output into a preview pane. Click **Accept** to replace the selection (Cmd+Z still works to undo); **Discard / Cancel** leaves it alone.

If something's wrong:

- **Ollama not detected** → start the Ollama app (macOS) or `ollama serve` (Linux/Windows terminal).
- **No models installed** → `ollama pull llama3.2:3b`.
- **"Couldn't reach the helper for LLM features"** → your helper binary is older than the client; rebuild + restart (`go build -o flowtex-helper` in `helper/`, then restart).
- **The dialog mentions a particular task isn't supported** → same fix; the new task was added in a later helper.

---

## Two-Factor Authentication (MFA)

Protect your account with TOTP-based two-factor authentication.

### Enabling MFA

1. Go to the toolbar > your profile menu > **MFA Setup**
2. Scan the QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)
3. Enter the 6-digit code to verify
4. MFA is now active — you'll need a code each time you log in

### Disabling MFA

1. Go to MFA Setup
2. Enter your password to confirm
3. Click **Disable MFA**

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Enter` | Compile project |
| `Cmd/Ctrl + S` | Save current file |
| `Cmd/Ctrl + F` | Find in editor |
| `Cmd/Ctrl + H` | Find and replace |
| `Cmd/Ctrl + D` | Select next occurrence |
| `Cmd/Ctrl + /` | Toggle line comment |
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Cmd/Ctrl + Shift + V` | Toggle Visual Mode |
| `Cmd/Ctrl + B` | Bold selection |
| `Cmd/Ctrl + I` | Italicize selection |
| `Cmd/Ctrl + Click` | Comment on selection |
| `Tab` | Indent selection |
| `Shift + Tab` | Dedent selection |

---

## Tips

- **Set the main file** if your project has multiple `.tex` files — right-click the root document in the file tree
- **Use SyncTeX** to jump between editor and PDF — saves time navigating large documents
- **Clean auxiliary files** if compilation produces unexpected results or gets stuck
- **Upload a ZIP** to quickly import an existing LaTeX project
- **Resolve comments** to keep the sidebar clean — resolved comments are hidden by default

---

## Admin Dashboard

If your account has the admin flag, the user menu shows an **Admin Dashboard** entry. It surfaces:

- **Overview** — total users / projects / files / versions / comments, with 7-day and 30-day deltas
- **Most Active Projects** — top 20 by recent edits, with an **Owner** column so you can see at a glance who runs each one
- **Active Users** — top 20 by edit count; each row shows a **Last Active** column (most recent of: edit, comment, or any audit-log entry such as a login) so you can tell engaged users from dormant accounts at a glance. Click any row to drill into their projects, recent edits, comments, chat, audit entries, and login history
- **Audit log** — every security-relevant event (logins, password / MFA changes, snapshot restores, GitHub-token issuance, admin actions); exportable as CSV
- **SMTP settings** — test mail sending and rotate the admin SMTP password
- **Delete user** — each user row has a Delete button that opens a triple-check modal: acknowledge, type the target's exact email, enter *your* admin password, only then is the destructive button enabled. The flow cleans up the user's authorship on comments / replies / versions, drops any project they alone own, and sends a goodbye email. Admins cannot delete *themselves* through this flow — use the regular self-delete instead.

### About modal — which version is live?

Help → **About FlowTex** shows a **Build** line with the short git SHA and build timestamp (rendered in your local timezone). When the FlowTex server is deployed via the provisioner or via `cd client && npm run build`, the SHA is set automatically from `git rev-parse --short HEAD` at build time, so operators can confirm which commit is currently serving traffic — handy for sanity-checking a deploy. A build done with `npx vite build` directly (skipping the npm wrapper) or in an environment without git shows `dev`. The modal closes via the **Close** button in the body or by clicking the dark area outside the card.
