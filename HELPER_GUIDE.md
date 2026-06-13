# FlowTex Helper — Setup Guide

`flowtex-helper` is a small companion app that runs on **your own machine**. It enables two opt-in FlowTex features whose data should never leave your computer:

- **Local LaTeX compile** — projects compile via your local TeX Live install, not on the FlowTex server.
- **Local LLM writing assistant** — right-click selected text in the editor to rewrite / paraphrase / itemize via a local Ollama model.

Source files and PDFs travel only between your browser and your helper. The FlowTex server is not in the loop for those features.

---

## 1 · Install the helper

### macOS

1. Download `FlowTexHelper.dmg` from [github.com/stolucc/flowtex/releases](https://github.com/stolucc/flowtex/releases) (look for the most recent `helper-v*` tag).
1. Open the .dmg and drag **FlowTexHelper.app** to `/Applications`.
1. Right-click the app and choose **Open** the first time (the binary is ad-hoc signed, not notarised — Gatekeeper warns once).
1. An **fTx** icon appears in your menu bar; the helper is now running.

### Windows

1. Download `flowtex-helper-windows-amd64.exe` from the same [GitHub Releases](https://github.com/stolucc/flowtex/releases) page.
1. Move it somewhere stable (e.g. `C:\Program Files\FlowTex\flowtex-helper.exe` or a folder in your user profile).
1. Double-click to run. SmartScreen will warn the first time because the binary is not code-signed; click **More info** → **Run anyway**.
1. The **fTx** icon appears in your system tray (bottom-right notification area).
1. (Optional) for auto-start at login, drop a shortcut to the .exe into:

   ```text
   %AppData%\Microsoft\Windows\Start Menu\Programs\Startup
   ```

### Linux

```bash
curl -fsSL https://github.com/stolucc/flowtex/releases/latest/download/install.sh | bash
```

The installer downloads the helper binary, verifies the SHA256 against the release's signed `SHA256SUMS`, and installs to `/usr/local/bin/flowtex-helper`. Start it with `flowtex-helper` in a terminal (it stays in the foreground — use systemd for an always-on setup).

---

## 2 · Pair with FlowTex

Pairing tells your browser which helper to talk to and exchanges a bearer token.

1. In FlowTex, open **Account Settings → Compile**.
1. Generate a pairing code:
   - **macOS / Windows**: click the **fTx** tray icon → **Generate pairing code**. A native dialog shows the 6-digit code and auto-copies it to the clipboard.
   - **Linux**: run `flowtex-helper pair` in a terminal — it prints a 6-digit code.
1. Paste the code into the **Pair helper** input in FlowTex.
1. The status row flips green: **Paired. TeX Live YYYY**.

> The code is valid for 60 seconds and can be entered five times before the window closes (brute-force guard). If you miss the window, generate a new one.

### Disconnect

Click the **Helper** indicator in the editor toolbar to open its popover. When paired, it has a **Disconnect** action that drops the bearer token from this browser. The indicator flips back to "running but not paired" (or "not detected" if the helper isn't reachable), and the popover then shows the **Pair** / **Install** actions again so you can reconnect. Disconnect is per-browser and local-only — it doesn't stop the helper process.

---

## 3 · Use local compile

Once paired, set **Account Settings → Compile** → **Compile location** to **My local TeX Live**. You can override this per-project in **Project Settings → Compiler**.

If you have multiple TeX Live years installed (`/usr/local/texlive/2024`, `/usr/local/texlive/2025`, ...), the year picker shows what your helper can see.

---

## 4 · Use local LLM (writing assistant)

The helper proxies to [Ollama](https://ollama.com/) — a local-LLM runtime that ships as a single binary. Install it, pull at least one model, and the right-click menu options light up.

1. Install Ollama from [ollama.com](https://ollama.com/).
1. Pull a model. Good defaults:

   ```bash
   ollama pull llama3.2:3b     # ~2 GB, fast on most hardware
   ollama pull qwen2.5:7b      # ~5 GB, better at writing
   ```

1. Verify it's running:

   ```bash
   curl -s http://127.0.0.1:11434/api/tags
   ```

   You should see a JSON list of models.

1. In FlowTex, **select some text in the editor → right-click → pick an action**:
   - **Write to length…** — rewrite to a target word count.
   - **Paraphrase** — reword with similar length.
   - **Itemize** — convert prose into a LaTeX `itemize` environment.
   - **Write it out** — bullets back to a prose paragraph.
   - **Other…** — free-form instruction (textual transformations only).
1. The dialog streams tokens live. Click **Accept** to replace your selection; **Discard / Cancel** leaves it alone.

---

## 5 · Troubleshooting

**The helper isn't reachable.**
Make sure it's running. macOS: check the menu bar for fTx. Windows: check the system tray (bottom-right). Linux: `ps aux | grep flowtex-helper`. If it's not, start it.

**I just upgraded FlowTex and LLM features show "Failed to fetch".**
Your helper binary is older than the new endpoints. Rebuild + restart:

```bash
cd flowtex/helper
go build -o flowtex-helper
# Restart: Quit from menu bar and re-open, or Ctrl-C and re-run.
```

**Pairing failed / paired but compile says "Helper unavailable".**
Re-pair: in the helper menu bar, **Generate pairing code**, then paste it again in Account Settings → Compile. Tokens rotate on every pair, so the old browser is implicitly de-authenticated.

**LLM dialog says "Ollama is running but no models are installed".**
Pull at least one model: `ollama pull llama3.2:3b`, then re-open the dialog.

**Ollama runs on a non-default port.**
Edit `~/.flowtex-helper/config.json` (Windows: `%USERPROFILE%\.flowtex-helper\config.json`) and set `"llm_base_url": "http://127.0.0.1:PORT"`. The helper rejects non-loopback URLs at load time, so the value MUST be 127.0.0.1, ::1, or localhost.

**Self-hosting FlowTex on a different domain.**
The helper rejects requests from unknown origins. Add your domain:

```bash
flowtex-helper allow-origin https://your-flowtex.example.edu
```

then restart the helper.

### Windows-specific

**SmartScreen blocks the .exe.**
The binary is not Authenticode-signed. Click **More info** → **Run anyway** on the SmartScreen dialog the first time. To suppress it permanently for this file, run in PowerShell: `Unblock-File .\flowtex-helper.exe`.

**Firewall prompts about "Public networks".**
The helper binds **only** to `127.0.0.1` (loopback), which Windows Firewall never gates. The first-run prompt is over-broad — answer **No / Cancel** and the helper still works fine. There's no scenario where the helper needs an external-network firewall rule.

**Microsoft Defender / EDR quarantines the .exe.**
Unsigned binaries that bind a TCP socket + exec child processes (latexmk) are heuristically suspicious. Restore from quarantine in Defender Settings → Protection history → *flowtex-helper.exe* → Allow, and add an exclusion if it keeps recurring. Long-term fix on our side is Authenticode signing.

**Roaming AD profile warning at startup.**
If you see a startup warning about `%USERPROFILE%` being on a network share, your account uses a roaming profile and the bearer token traverses SMB on every read. Consider relocating the config to local storage, or just be aware that local-network read attempts on your profile share could read the token.

---

## What stays on your machine

- **Local compile**: project source + PDF travel browser → helper → browser only. Never touch the FlowTex server.
- **Local LLM**: selected text → helper → Ollama → helper → browser. Helper validates that the Ollama URL is loopback before each request.

For full security details see `helper/README.md` and `LOCAL_COMPILE_DEPLOY.md` in the FlowTex repo.
