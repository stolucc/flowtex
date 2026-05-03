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

- **Rename**: Click the project name or use the context menu
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

```
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
- **Set main file**: Right-click a `.tex` file > Set as Main File — this is the file that gets compiled
- **Upload ZIP**: Use the toolbar menu to upload a ZIP archive of files

### LaTeX Editor (Center)

The editor provides a full-featured LaTeX editing experience:

- **Syntax highlighting** for LaTeX commands, environments, math, and comments
- **Autocomplete**: Type `\` to see LaTeX command suggestions, or start a `\begin{` for environment completion
- **Bracket matching**: Matching braces, brackets, and parentheses are highlighted
- **Search & replace**: Use `Cmd/Ctrl+F` to find, `Cmd/Ctrl+H` to replace
- **Multiple cursors**: `Cmd/Ctrl+D` to select next occurrence
- **Line numbers**: Shown in the gutter
- **Spellcheck**: Misspelled words are underlined — right-click for suggestions
- **Lint diagnostics**: Syntax issues from LaCheck appear as warnings in the gutter

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
- **Lint panel**: Toggle the diagnostics panel to see all warnings/errors
- **Console**: Toggle to see full compilation output

### Comments Sidebar (Far Right)

- **Add a comment**: Select text in the editor, then click the comment icon that appears, or use the toolbar
- **Reply**: Click a comment to expand it, then type a reply
- **Resolve**: Click the checkmark to resolve a comment thread
- **Edit/Delete**: Use the menu on your own comments to edit or delete them
- Comments are positioned alongside the relevant lines in the editor

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
| `Tab` | Indent selection |
| `Shift + Tab` | Dedent selection |

---

## Tips

- **Set the main file** if your project has multiple `.tex` files — right-click the root document in the file tree
- **Use SyncTeX** to jump between editor and PDF — saves time navigating large documents
- **Clean auxiliary files** if compilation produces unexpected results or gets stuck
- **Upload a ZIP** to quickly import an existing LaTeX project
- **Resolve comments** to keep the sidebar clean — resolved comments are hidden by default
