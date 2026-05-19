//go:build darwin || windows

// Tray (menu-bar / system-tray) runtime for the helper. Only built on
// macOS and Windows — Linux has no portable tray story (GNOME removed
// StatusNotifierItem in 3.26, KDE/XFCE/MATE all expose it differently),
// so Linux falls back to the headless server path and is expected to
// run as a systemd user service.
//
// Design constraints:
//   - The helper is still the same binary. `flowtex-helper` (no args)
//     boots the HTTP server AND the tray; `flowtex-helper --no-tray`
//     keeps the historical headless behavior.
//   - systray's runtime takes over the main goroutine and never
//     returns, so the HTTP server runs in a goroutine. Both share a
//     single context for clean shutdown.
//   - Browser open uses `os/exec` with the platform's url-opener;
//     never shell out to a shell.

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/getlantern/systray"
)

// trayState is the shared state the tray menu reads to render itself.
// Mutations come from two places: (1) successful POST /pair, which sets
// paired=true (wired in server.go); (2) the user clicking "Generate
// pairing code" in the menu, which opens a 60s pairing window.
type trayState struct {
	mu          sync.Mutex
	cfg         *config
	server      *server
	httpServer  *http.Server
	logger      *log.Logger
	cancel      context.CancelFunc
	pairCodeMI  *systray.MenuItem // dynamically shown for 60s after "Generate pairing code"
	pairExpiry  time.Time
}

var tray = &trayState{}

// runWithTray boots the HTTP server in a goroutine and hands the main
// thread to systray.Run, which blocks until the user picks "Quit". This
// is the entrypoint for the default (tray-on) path on macOS/Windows.
func runWithTray(cfg *config, srv *server, httpServer *http.Server, logger *log.Logger, cancel context.CancelFunc) {
	tray.cfg = cfg
	tray.server = srv
	tray.httpServer = httpServer
	tray.logger = logger
	tray.cancel = cancel

	go func() {
		var err error
		if cfg.UseTLS {
			err = httpServer.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile)
		} else {
			err = httpServer.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("listen: %v", err)
		}
	}()

	systray.Run(onTrayReady, onTrayExit)
}

func onTrayReady() {
	// Using a text title rather than an icon for v1 — a proper template
	// icon needs cross-platform PNG/ICO assets and codesign-aware build
	// plumbing. "fTx" is short enough not to crowd the menu bar.
	systray.SetTitle("fTx")
	systray.SetTooltip("flowtex-helper — local LaTeX compile")

	statusMI := systray.AddMenuItem("Helper running", "")
	statusMI.Disable()
	systray.AddSeparator()

	pairMI := systray.AddMenuItem("Generate pairing code…", "Print a 6-digit code, valid for 60s")
	openMI := systray.AddMenuItem("Open FlowTex pairing page", "Opens https://flowtex.click in your browser")

	// Default TeX Live submenu — one entry per /usr/local/texlive/YYYY
	// the helper can find. Picking one writes the year into config
	// and rebuilds $PATH so subsequent unpinned compiles (no
	// `texDistribution` field on the request) use it. Project
	// Settings pins still override.
	systray.AddSeparator()
	distRoot := systray.AddMenuItem("Default TeX Live", "Pick the year used for compile requests without an explicit pin")
	distItems := buildDistributionMenu(distRoot)

	systray.AddSeparator()
	quitMI := systray.AddMenuItem("Quit", "Stop the helper and exit")

	// The status string reflects whether a bearer token is set (the
	// browser has paired at some point) vs. fresh-install state. It
	// does NOT prove the browser is still listening — that's a
	// liveness concern the FlowTex UI itself surfaces via its probe.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			refreshStatus(statusMI)
			<-ticker.C
		}
	}()

	// Dynamic select cases: pair / open / quit + one per distribution.
	// reflect would tidy this up, but the menu-item count is tiny (one
	// per /usr/local/texlive/YYYY) so a hand-rolled fan-in is clearer
	// and avoids pulling reflect in. Each distItem ships its own
	// goroutine that turns its ClickedCh into a call to
	// switchDefaultDistribution(year, distItems) which updates check
	// marks across the whole submenu.
	for _, item := range distItems {
		go listenDistributionClick(item, distItems)
	}

	for {
		select {
		case <-pairMI.ClickedCh:
			go handleGeneratePair()
		case <-openMI.ClickedCh:
			go openBrowser("https://flowtex.click")
		case <-quitMI.ClickedCh:
			systray.Quit()
			return
		}
	}
}

// distributionMenuItem couples a tray entry to the year it represents.
// Held in a slice so the click handler can iterate and toggle check
// marks across all entries when the user picks a different default.
type distributionMenuItem struct {
	year string
	item *systray.MenuItem
}

// buildDistributionMenu populates the "Default TeX Live" submenu with
// one entry per installed year, plus a "System default" entry meaning
// "no year preference — first match on PATH wins". The check mark
// reflects cfg.DefaultTexYear at startup; later picks call
// switchDefaultDistribution which re-marks atomically.
func buildDistributionMenu(root *systray.MenuItem) []distributionMenuItem {
	var items []distributionMenuItem

	// "(System default)" entry first — semantically a clear option
	// even when there's only one installed year.
	def := root.AddSubMenuItem("System default", "Let $PATH order decide which year wins")
	items = append(items, distributionMenuItem{year: "", item: def})

	for _, d := range detectAllDistributions() {
		mi := root.AddSubMenuItem("TeX Live "+d.Year, "Prefer this year for compiles without an explicit pin")
		items = append(items, distributionMenuItem{year: d.Year, item: mi})
	}

	// Apply the current preference: check the matching entry, leave
	// the rest unchecked.
	current := ""
	if cfg, err := loadConfig(); err == nil {
		current = cfg.DefaultTexYear
	}
	for _, it := range items {
		if it.year == current {
			it.item.Check()
		} else {
			it.item.Uncheck()
		}
	}
	if len(items) == 1 {
		// Only the System-default entry — no installed distributions
		// to pick between. Disable the placeholder so the submenu
		// isn't a dead-end click.
		def.Disable()
	}
	return items
}

// listenDistributionClick blocks on a single submenu entry's click
// channel and, on each click, calls switchDefaultDistribution.
// Forever-loop so a single click doesn't unsubscribe; systray
// re-arms ClickedCh on every click.
func listenDistributionClick(self distributionMenuItem, all []distributionMenuItem) {
	for range self.item.ClickedCh {
		switchDefaultDistribution(self.year, all)
	}
}

// switchDefaultDistribution persists the new preference, recomputes
// $PATH so future exec.LookPath calls prefer the chosen year, and
// flips check marks across the submenu so the UI reflects the new
// state without a relaunch.
func switchDefaultDistribution(year string, all []distributionMenuItem) {
	cfg, err := loadConfig()
	if err != nil {
		if tray.logger != nil {
			tray.logger.Printf("switch default distribution: %v", err)
		}
		return
	}
	cfg.DefaultTexYear = year
	if err := saveConfig(cfg); err != nil {
		if tray.logger != nil {
			tray.logger.Printf("save config: %v", err)
		}
		return
	}
	// Recompute PATH so the next detectTex() / runCompile sees the
	// new default first.
	augmentPathForTeX(year)

	// Flip the check marks. systray doesn't expose a "radio group"
	// abstraction so we manage exclusivity ourselves.
	for _, it := range all {
		if it.year == year {
			it.item.Check()
		} else {
			it.item.Uncheck()
		}
	}
}

func onTrayExit() {
	// Tray loop ended; tear down the HTTP server cleanly so we don't
	// leave a dangling listener. The signal-context cancel triggers
	// the same shutdown path used by Ctrl-C in headless mode.
	if tray.cancel != nil {
		tray.cancel()
	}
	if tray.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tray.httpServer.Shutdown(ctx)
	}
}

func refreshStatus(statusMI *systray.MenuItem) {
	tray.mu.Lock()
	hasToken := tray.cfg != nil && tray.cfg.BearerToken != ""
	tray.mu.Unlock()
	if hasToken {
		statusMI.SetTitle("● Paired")
	} else {
		statusMI.SetTitle("○ Awaiting pairing")
	}
}

// handleGeneratePair opens the 60-second pairing window in-process and
// surfaces the resulting code three ways at once: a native dialog so
// the user sees it immediately (clicking the menu item dismisses the
// menu, so a disabled menu-item alone is invisible until they reopen
// it); the system clipboard so they can paste into FlowTex; and a
// persistent disabled menu item so they can re-read after dismissing
// the dialog. The item updates to "expired" after 60s.
func handleGeneratePair() {
	tray.mu.Lock()
	cfg := tray.cfg
	tray.mu.Unlock()
	if cfg == nil {
		return
	}

	code := startPairingWindow(cfg)
	expiry := time.Now().Add(60 * time.Second)

	tray.mu.Lock()
	if tray.pairCodeMI != nil {
		tray.pairCodeMI.Hide()
	}
	tray.pairCodeMI = systray.AddMenuItem(fmt.Sprintf("Code: %s  (expires in 60s)", code), "")
	tray.pairCodeMI.Disable()
	tray.pairExpiry = expiry
	tray.mu.Unlock()

	// Copy first, then dialog. If the dialog blocks (it does on macOS
	// until the user clicks OK), the clipboard is already set so the
	// user can paste mid-dialog.
	copyToClipboard(code)
	showPairCodeDialog(code)

	go func() {
		<-time.After(60 * time.Second)
		tray.mu.Lock()
		if tray.pairCodeMI != nil && !time.Now().Before(tray.pairExpiry) {
			tray.pairCodeMI.SetTitle("Code expired — click Generate again")
		}
		tray.mu.Unlock()
	}()
}

// showPairCodeDialog pops a native modal with the code. macOS uses
// osascript (built into the OS — no extra dependency); Windows uses
// PowerShell's System.Windows.Forms MessageBox. Both run the dialog
// in their own process so we don't block the systray goroutine, but
// we still .Run() to wait — the dialog dismissing is when the user
// is most likely to switch to FlowTex.
func showPairCodeDialog(code string) {
	switch runtime.GOOS {
	case "darwin":
		// osascript's display-dialog string is single-line; embed
		// "\n" explicitly. The code itself is digits-only, so no
		// quote-escaping concerns.
		script := fmt.Sprintf(
			`display dialog "Pairing code:\n\n        %s\n\nValid for 60 seconds. Already copied to clipboard." `+
				`with title "FlowTex Helper" `+
				`buttons {"OK"} default button "OK" `+
				`with icon note`,
			code,
		)
		if err := exec.Command("osascript", "-e", script).Run(); err != nil && tray.logger != nil {
			tray.logger.Printf("show dialog: %v", err)
		}
	case "windows":
		// Quotes are escaped via PowerShell's backtick. Code is digit-
		// only so there's no injection surface, but defence-in-depth.
		ps := fmt.Sprintf(
			`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Pairing code: %s`+"`n`n"+`Valid for 60 seconds. Already copied to clipboard.', 'FlowTex Helper') | Out-Null`,
			code,
		)
		if err := exec.Command("powershell", "-NoProfile", "-Command", ps).Run(); err != nil && tray.logger != nil {
			tray.logger.Printf("show dialog: %v", err)
		}
	}
}

// copyToClipboard places `text` on the system clipboard. macOS pbcopy
// reads stdin; Windows clip.exe does the same. Best-effort — if the
// helper fails the user still has the menu item + dialog.
func copyToClipboard(text string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbcopy")
	case "windows":
		cmd = exec.Command("clip")
	default:
		return
	}
	cmd.Stdin = strings.NewReader(text)
	if err := cmd.Run(); err != nil && tray.logger != nil {
		tray.logger.Printf("copy to clipboard: %v", err)
	}
}

// openBrowser launches the platform's URL handler. No shell, no
// substitution — the URL is passed as a single argv element.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil && tray.logger != nil {
		tray.logger.Printf("openBrowser %q: %v", url, err)
	}
}
