// Config: load / save the helpers config file at ~/.flowtex-helper/config.json.
//
// Defaults are written on first run so the user does not need to hand-edit
// the file. Bearer token is generated lazily — pairing will rotate it on
// first use.

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type config struct {
	Version        int      `json:"version"`
	Port           int      `json:"port"`
	BearerToken    string   `json:"bearer_token"`
	AllowedOrigins []string `json:"allowed_origins"`
	ShellEscape    bool     `json:"shell_escape"`
	Telemetry      bool     `json:"telemetry"`

	// File paths derived from the config location. Not persisted.
	Path     string `json:"-"`
	CertFile string `json:"-"`
	KeyFile  string `json:"-"`
}

const defaultPort = 9876
const configFileName = "config.json"
const certDirName = "certs"

func defaultAllowedOrigins() []string {
	// Both schemes/ports so dev (https://localhost:3001) and Vite
	// (http://localhost:5173) work out of the box. Production
	// self-hosters add their domain via `flowtex-helper info` + manual
	// edit (or future `flowtex-helper allow-origin` subcommand).
	return []string{
		"https://flowtex.click",
		"https://localhost:3001",
		"http://localhost:3001",
		"http://localhost:5173",
	}
}

// configDir returns ~/.flowtex-helper, creating it if missing.
func configDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".flowtex-helper")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

func loadConfig() (*config, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, configFileName)
	certDir := filepath.Join(dir, certDirName)
	if err := os.MkdirAll(certDir, 0o700); err != nil {
		return nil, err
	}

	cfg := &config{
		Path:     path,
		CertFile: filepath.Join(certDir, "helper.crt"),
		KeyFile:  filepath.Join(certDir, "helper.key"),
	}

	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		cfg.Version = 1
		cfg.Port = defaultPort
		cfg.BearerToken = generateToken()
		cfg.AllowedOrigins = defaultAllowedOrigins()
		cfg.ShellEscape = false
		cfg.Telemetry = false
		if err := saveConfig(cfg); err != nil {
			return nil, fmt.Errorf("write initial config: %w", err)
		}
		return cfg, nil
	}
	if err != nil {
		return nil, err
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// Backfill any missing fields after a config-schema bump. Each
	// branch is independently safe to re-run.
	if cfg.Port == 0 {
		cfg.Port = defaultPort
	}
	if cfg.BearerToken == "" {
		cfg.BearerToken = generateToken()
	}
	if len(cfg.AllowedOrigins) == 0 {
		cfg.AllowedOrigins = defaultAllowedOrigins()
	}

	return cfg, nil
}

func saveConfig(cfg *config) error {
	out := *cfg
	out.Path = "" // do not persist derived paths
	out.CertFile = ""
	out.KeyFile = ""

	data, err := json.MarshalIndent(&out, "", "  ")
	if err != nil {
		return err
	}
	// Atomic replace via tmpfile + rename. Mode 0600 — token is in there.
	tmp, err := os.CreateTemp(filepath.Dir(cfg.Path), ".config.tmp")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), cfg.Path)
}

// generateToken returns a 32-byte random hex string (~256 bits of entropy).
// Crypto-grade source — used as the bearer token authenticating every
// authenticated request to the helper.
func generateToken() string {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand failures are catastrophic — refuse to run rather
		// than silently fall back to a weak token.
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(buf[:])
}
