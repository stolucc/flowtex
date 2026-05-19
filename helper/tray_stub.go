//go:build !darwin && !windows

// Stub for platforms with no portable tray story (Linux). The function
// signature mirrors tray.go so main.go can call it unconditionally;
// here it falls through to headless run so the helper still serves
// requests when invoked without `--no-tray`.

package main

import (
	"context"
	"errors"
	"log"
	"net/http"
)

func runWithTray(cfg *config, srv *server, httpServer *http.Server, logger *log.Logger, cancel context.CancelFunc) {
	_ = cancel
	_ = srv
	logger.Printf("tray UI is not supported on this OS; running headless. " +
		"Use a systemd user service to auto-start on login.")
	var err error
	if cfg.UseTLS {
		err = httpServer.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile)
	} else {
		err = httpServer.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Fatalf("listen: %v", err)
	}
}
