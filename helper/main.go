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
	"syscall"
	"time"
)

func main() {
	logger := log.New(os.Stderr, "", log.LstdFlags)

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
		case "help", "-h", "--help":
			printHelp()
			return
		case "version":
			fmt.Println("flowtex-helper", helperVersion)
			return
		}
	}

	// Default: run the server.
	var portFlag = flag.Int("port", 0, "override the configured port (default reads from config)")
	flag.CommandLine.Parse(os.Args[1:])

	cfg, err := loadConfig()
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}
	if *portFlag > 0 {
		cfg.Port = *portFlag
	}

	if err := ensureTLSCert(cfg); err != nil {
		logger.Fatalf("ensure TLS cert: %v", err)
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

	logger.Printf("flowtex-helper %s listening on https://127.0.0.1:%d (config: %s)",
		helperVersion, cfg.Port, cfg.Path)
	logger.Printf("allowed origins: %v", cfg.AllowedOrigins)
	logger.Printf("first-time pairing? run: flowtex-helper pair")

	if err := srv.HTTP.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatalf("listen: %v", err)
	}
	logger.Print("shutdown complete")
}

func printHelp() {
	fmt.Print(`flowtex-helper — local LaTeX compile companion for FlowTex.

Usage:
  flowtex-helper                run the helper (foreground)
  flowtex-helper pair           print a one-time 6-digit pairing code
  flowtex-helper rotate         rotate the bearer token
  flowtex-helper info           print config path + listening port + cert fingerprint
  flowtex-helper version        print version
  flowtex-helper help           this message

Config file: ~/.flowtex-helper/config.json (auto-created on first run).
TLS cert:    ~/.flowtex-helper/certs/   (self-signed, regenerated if missing).

Once running, pair with a FlowTex browser tab:
  1. In this terminal:        flowtex-helper pair
  2. Copy the 6-digit code.
  3. In FlowTex:              Account Settings → Compile → Pair helper.
  4. Paste the code.
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
	fmt.Printf("allowed origins:  %v\n", cfg.AllowedOrigins)
	fmt.Printf("bearer token set: %v\n", cfg.BearerToken != "")
	if fp, err := certFingerprint(cfg.CertFile); err == nil {
		fmt.Printf("TLS fingerprint:  %s\n", fp)
	}
}
