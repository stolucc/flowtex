// Config round-trip tests. Pin the on-disk shape so a future
// schema bump doesnt silently lose the bearer token or the
// allowed-origins list.

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSaveAndLoadConfig_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfg := &config{
		Version:        1,
		Port:           9876,
		BearerToken:    "deadbeef",
		AllowedOrigins: []string{"https://flowtex.click"},
		Path:           filepath.Join(dir, "config.json"),
		CertFile:       filepath.Join(dir, "helper.crt"),
		KeyFile:        filepath.Join(dir, "helper.key"),
	}
	if err := saveConfig(cfg); err != nil {
		t.Fatalf("saveConfig: %v", err)
	}

	raw, err := os.ReadFile(cfg.Path)
	if err != nil {
		t.Fatalf("read back config: %v", err)
	}
	var disk map[string]interface{}
	if err := json.Unmarshal(raw, &disk); err != nil {
		t.Fatalf("parse persisted config: %v", err)
	}

	// The persisted file MUST contain the bearer token (no point in
	// auth if it doesn't survive a process restart) AND MUST NOT
	// contain the derived path fields (those are runtime-only).
	if disk["bearer_token"] != "deadbeef" {
		t.Errorf("bearer_token missing from disk: got %v", disk["bearer_token"])
	}
	for _, derived := range []string{"Path", "CertFile", "KeyFile"} {
		if _, present := disk[derived]; present {
			t.Errorf("derived field %q should not be persisted, got %v", derived, disk[derived])
		}
	}
}

func TestSaveConfig_FileMode0600(t *testing.T) {
	// Bearer token sits in this file. World-readable would leak it to
	// any unix user on a shared machine.
	//
	// Windows: file modes don't map to Unix permission bits -- os.Stat
	// reports 0666 regardless of the 0600 we passed to os.OpenFile. The
	// equivalent protection on Windows is the icacls DACL lockdown
	// applied in config_windows.go (verified by TestApplyWindowsACL in
	// config_acl_test.go). So this test is skipped on Windows and the
	// Windows-specific test covers that path.
	if runtime.GOOS == "windows" {
		t.Skip("file modes don't apply on Windows; see TestApplyWindowsACL")
	}
	dir := t.TempDir()
	cfg := &config{
		Path:        filepath.Join(dir, "config.json"),
		BearerToken: "deadbeef",
	}
	if err := saveConfig(cfg); err != nil {
		t.Fatalf("saveConfig: %v", err)
	}
	info, err := os.Stat(cfg.Path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("config file mode = %o, want 0600", mode)
	}
}

func TestGenerateToken_LooksLikeHex(t *testing.T) {
	tok := generateToken()
	if len(tok) != 64 {
		t.Errorf("token length = %d, want 64 (32 bytes hex)", len(tok))
	}
	for _, r := range tok {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			t.Errorf("non-hex char %q in token %q", r, tok)
			return
		}
	}
}

func TestGenerateToken_DistinctEachCall(t *testing.T) {
	a, b := generateToken(), generateToken()
	if a == b {
		t.Errorf("two successive tokens are identical (random source broken?)")
	}
}
