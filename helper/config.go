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
	Telemetry      bool     `json:"telemetry"`
	// DefaultTexYear, when set, picks which installed TeX Live year
	// the helper prefers on PATH. Used for compile requests that
	// don't carry an explicit `texDistribution` (e.g. browser tabs
	// that haven't pinned one in Project Settings). Empty = whatever
	// the PATH glob orders first.
	DefaultTexYear string `json:"default_tex_year,omitempty"`

	// LLM (local-only). All optional; defaults pick up a stock
	// Ollama install at http://127.0.0.1:11434.
	//   LLMBaseURL    — must be loopback (validated on load + per request).
	//   LLMDefaultModel — used when /llm/complete is called without
	//                     an explicit model.
	LLMBaseURL      string `json:"llm_base_url,omitempty"`
	LLMDefaultModel string `json:"llm_default_model,omitempty"`

	// File paths derived from the config location. Not persisted.
	Path     string `json:"-"`
	CertFile string `json:"-"`
	KeyFile  string `json:"-"`

	// Runtime listen mode. Set from the --tls flag at startup. Not
	// persisted — restarting without --tls returns to plain HTTP.
	UseTLS bool `json:"-"`
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
	// Windows: os.MkdirAll only sets the read-only bit, not a proper
	// NTFS DACL. secureDirACL drops inherited ACEs and grants only the
	// current user FullControl. No-op on Unix. Best-effort: if icacls
	// isn't on PATH for some reason the helper still runs; just less
	// hardened against other local users.
	if err := secureDirACL(dir); err != nil {
		// Can't log here cleanly (no logger in scope); the caller's
		// next saveConfig will surface a similar diagnostic if needed.
		_ = err
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
	// Defence in depth: DefaultTexYear ends up in a filepath.Join /
	// Glob call. Anything written legitimately (via the tray) is
	// already a 4-digit year, but a hand-edited config could put
	// ".." or worse in here, which filepath.Join would clean into a
	// directory the attacker controls. Silently drop bad values
	// rather than trust them.
	if cfg.DefaultTexYear != "" && !isValidTexYear(cfg.DefaultTexYear) {
		cfg.DefaultTexYear = ""
	}
	// Defence in depth: a hand-edited config can't accidentally point
	// the LLM at a non-loopback endpoint that would exfiltrate the
	// user's selected text. Silently drop a bad value rather than fail
	// to start — the LLM endpoints will return a useful error.
	if cfg.LLMBaseURL != "" && validateLLMBaseURL(cfg.LLMBaseURL) != nil {
		cfg.LLMBaseURL = ""
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
	if err := os.Rename(tmp.Name(), cfg.Path); err != nil {
		return err
	}
	// Windows: re-apply the explicit DACL after the rename. The
	// rename inherits the new directory's ACL — secureDirACL has
	// already locked the dir down so children inherit a sane ACL,
	// but the explicit per-file lockdown is belt-and-suspenders so
	// a (hypothetical) future loosening of the dir ACL doesn't
	// also widen the token file. No-op on Unix.
	if err := secureFileACL(cfg.Path); err != nil {
		// Best-effort: file is written, just not extra-locked.
		// Don't fail saveConfig for this — the read/write op
		// succeeded; the user-vs-user gap is the only thing we
		// failed to close.
		_ = err
	}
	return nil
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
