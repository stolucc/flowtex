// Package main is the flowtex-helper binary. See README.md.
//
// One process per user, runs on the user's own machine, listens only on
// 127.0.0.1. Compiles LaTeX projects shipped over the bridge from a
// FlowTex web app (https://flowtex.click or self-hosted) using whatever
// TeX Live is installed locally. Source + PDFs never leave the user's
// machine.
//
// Subcommands:
//   flowtex-helper          — run the helper (default)
//   flowtex-helper pair     — enter pairing mode for 60s, print a 6-digit
//                              code for the browser to use
//   flowtex-helper rotate   — rotate the bearer token (invalidates all
//                              previously-paired browsers)
//   flowtex-helper info     — print config path, port, allowed origins,
//                              cert fingerprint
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

func main() {
	logger := log.New(os.Stderr, "", log.LstdFlags)

	// Prepend the standard TeX Live + Homebrew locations to $PATH so
	// the helper can find latexmk / tex / pdflatex even when launched
	// as a macOS .app (launchd hands GUI apps a bare PATH that
	// excludes /Library/TeX/texbin and /usr/local/texlive/*). Without
	// this, year detection fails and the FlowTex badge shows
	// "TeX Live ?" after a successful pair — and compile fails.
	augmentPathForTeX()

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "pair":
			runPair(logger)
			return
		case "rotate":
			runRotate(logger)
			return
		case "info":
			runInfo(logger)
			return
		case "allow-origin":
			runAllowOrigin(logger, os.Args[2:])
			return
		case "deny-origin":
			runDenyOrigin(logger, os.Args[2:])
			return
		case "help", "-h", "--help":
			printHelp()
			return
		case "version":
			fmt.Println("flowtex-helper", helperVersion)
			return
		}
	}

	// Default: run the server.
	//
	// Listen scheme is HTTP by default. The helper binds to 127.0.0.1
	// only, and modern browsers treat http://localhost as a "potentially
	// trustworthy" origin exempt from mixed-content blocking even when
	// the calling FlowTex page is on HTTPS (W3C Secure Contexts §3.1).
	// So plain HTTP eliminates the entire self-signed-cert acceptance
	// step without weakening any real security property — the token
	// auth + origin allowlist + host pin still apply.
	//
	// Users who want belt-and-suspenders TLS can pass --tls; the helper
	// then generates a self-signed cert (as in Phase 1 v0.1) and serves
	// HTTPS on the same port. The trust dance is back, but for users
	// who actively want it.
	var portFlag = flag.Int("port", 0, "override the configured port (default reads from config)")
	var tlsFlag = flag.Bool("tls", false, "serve HTTPS with a self-signed cert instead of HTTP")
	// Tray UI defaults to ON for macOS / Windows (where the menu-bar /
	// system-tray story is solid), OFF for Linux and everything else.
	// --no-tray forces headless even on platforms that would otherwise
	// boot the tray; useful for systemd services, CI, debugging.
	var noTrayFlag = flag.Bool("no-tray", false, "run headless even on platforms that default to the tray UI")
	flag.CommandLine.Parse(os.Args[1:])

	cfg, err := loadConfig()
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}
	if *portFlag > 0 {
		cfg.Port = *portFlag
	}
	cfg.UseTLS = *tlsFlag

	if cfg.UseTLS {
		if err := ensureTLSCert(cfg); err != nil {
			logger.Fatalf("ensure TLS cert: %v", err)
		}
	}

	if err := saveConfig(cfg); err != nil {
		logger.Fatalf("save config: %v", err)
	}

	srv, err := newServer(cfg, logger)
	if err != nil {
		logger.Fatalf("build server: %v", err)
	}

	// Trap signals so we cleanly shut down the HTTP listener AND cancel
	// any in-flight compile via the server's context. Avoids dangling
	// latexmk processes on Ctrl-C.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	go func() {
		<-ctx.Done()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = srv.HTTP.Shutdown(shutdownCtx)
	}()

	scheme := "http"
	if cfg.UseTLS {
		scheme = "https"
	}
	logger.Printf("flowtex-helper %s listening on %s://127.0.0.1:%d (config: %s)",
		helperVersion, scheme, cfg.Port, cfg.Path)
	logger.Printf("allowed origins: %v", cfg.AllowedOrigins)
	logger.Printf("first-time pairing? click the menu-bar icon or run: flowtex-helper pair")

	// trayDefault is true on the platforms where runWithTray is the real
	// tray implementation (build tags handle the OS split). On Linux the
	// stub is invoked but immediately falls back to headless, so the
	// branching here is purely about WHICH log line we want to print.
	if !*noTrayFlag && trayDefault() {
		runWithTray(cfg, srv, srv.HTTP, logger, cancel)
		logger.Print("shutdown complete")
		return
	}

	var listenErr error
	if cfg.UseTLS {
		listenErr = srv.HTTP.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile)
	} else {
		listenErr = srv.HTTP.ListenAndServe()
	}
	if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
		logger.Fatalf("listen: %v", listenErr)
	}
	logger.Print("shutdown complete")
}

// trayDefault reports whether the tray UI is the expected default on
// the current OS. macOS and Windows both have stable tray primitives;
// Linux's tray story is fragmented and we instead expect the helper to
// run as a systemd user service.
func trayDefault() bool {
	switch runtime.GOOS {
	case "darwin", "windows":
		return true
	default:
		return false
	}
}

func printHelp() {
	fmt.Print(`flowtex-helper — local LaTeX compile companion for FlowTex.

Usage:
  flowtex-helper                       run the helper (foreground)
  flowtex-helper pair                  print a one-time 6-digit pairing code
  flowtex-helper rotate                rotate the bearer token
  flowtex-helper allow-origin <url>    add a FlowTex origin to the trust list
  flowtex-helper deny-origin <url>     remove an origin from the trust list
  flowtex-helper info                  print config path + port + trusted origins
  flowtex-helper version               print version
  flowtex-helper help                  this message

Config file: ~/.flowtex-helper/config.json (auto-created on first run).
TLS cert:    ~/.flowtex-helper/certs/   (only used when running with --tls).

Once running, pair with a FlowTex browser tab:
  1. In this terminal:        flowtex-helper pair
  2. Copy the 6-digit code.
  3. In FlowTex:              Account Settings → Compile → Pair helper.
  4. Paste the code.

Self-hosters on a non-default FlowTex domain need to trust their server
first:
  flowtex-helper allow-origin https://latex.example.edu
`)
}

const helperVersion = "0.1.0-dev"

func runPair(logger *log.Logger) {
	cfg, err := loadConfig()
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}
	code := startPairingWindow(cfg)
	fmt.Printf(`
Pairing code: %s
This code is valid for 60 seconds. The helper process must already be
running in another terminal — the code only registers a *future* token
swap; the actual swap happens when the browser POSTs /pair?code=%s to
the running helper.

If the helper is not running, start it first:
  flowtex-helper

Config dir: %s
`, code, code, filepath.Dir(cfg.Path))
}

func runRotate(logger *log.Logger) {
	cfg, err := loadConfig()
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}
	cfg.BearerToken = generateToken()
	if err := saveConfig(cfg); err != nil {
		logger.Fatalf("save config: %v", err)
	}
	fmt.Println("bearer token rotated.")
	fmt.Println("all previously-paired browsers are now de-authenticated and must re-pair.")
}

func runInfo(logger *log.Logger) {
	cfg, err := loadConfig()
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}
	fmt.Printf("config:           %s\n", cfg.Path)
	fmt.Printf("port:             %d\n", cfg.Port)
	fmt.Printf("bearer token set: %v\n", cfg.BearerToken != "")
	fmt.Println("trusted origins:")
	for _, o := range cfg.AllowedOrigins {
		fmt.Printf("  - %s\n", o)
	}
	if fp, err := certFingerprint(cfg.CertFile); err == nil {
		fmt.Printf("TLS fingerprint:  %s\n", fp)
	}
}

func runAllowOrigin(logger *log.Logger, args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: flowtex-helper allow-origin <url>")
		fmt.Fprintln(os.Stderr, "Example: flowtex-helper allow-origin https://latex.example.edu")
		os.Exit(2)
	}
	origin, err := normalizeOrigin(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid origin: %v\n", err)
		os.Exit(2)
	}
	cfg, err := loadConfig()
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}
	if added := addAllowedOrigin(cfg, origin); !added {
		fmt.Printf("%s is already trusted. No change.\n", origin)
		return
	}
	if err := saveConfig(cfg); err != nil {
		logger.Fatalf("save config: %v", err)
	}
	fmt.Printf("Trusted: %s\n", origin)
	fmt.Println()
	fmt.Println("Restart the helper for the change to take effect:")
	fmt.Println("  (Ctrl-C the running helper, then re-run ./flowtex-helper)")
}

func runDenyOrigin(logger *log.Logger, args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: flowtex-helper deny-origin <url>")
		os.Exit(2)
	}
	origin, err := normalizeOrigin(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid origin: %v\n", err)
		os.Exit(2)
	}
	cfg, err := loadConfig()
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}
	if removed := removeAllowedOrigin(cfg, origin); !removed {
		fmt.Printf("%s is not in the trust list. No change.\n", origin)
		return
	}
	if err := saveConfig(cfg); err != nil {
		logger.Fatalf("save config: %v", err)
	}
	fmt.Printf("Removed: %s\n", origin)
	fmt.Println()
	fmt.Println("Restart the helper for the change to take effect.")
}
