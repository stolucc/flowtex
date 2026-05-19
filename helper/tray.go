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
// surfaces the resulting code as a dynamic disabled menu item so the
// user can read it without flipping to a terminal. The item expires
// when the pairing window does.
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

	go func() {
		<-time.After(60 * time.Second)
		tray.mu.Lock()
		if tray.pairCodeMI != nil && !time.Now().Before(tray.pairExpiry) {
			tray.pairCodeMI.SetTitle("Code expired — click Generate again")
		}
		tray.mu.Unlock()
	}()
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
