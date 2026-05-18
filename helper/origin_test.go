package main

import (
	"testing"
)

func TestNormalizeOrigin_Canonical(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://latex.uni.edu", "https://latex.uni.edu"},
		{"https://latex.uni.edu/", "https://latex.uni.edu"},
		{"HTTPS://Latex.UNI.edu", "https://latex.uni.edu"},
		{"https://flowtex.click/some/path?q=1", "https://flowtex.click"},
		{"https://flowtex.click:443", "https://flowtex.click"},
		{"http://example.com:80/x", "http://example.com"},
		{"http://localhost:3001", "http://localhost:3001"},
		{"https://localhost:5173", "https://localhost:5173"},
		{"  https://example.com  ", "https://example.com"},
	}
	for _, c := range cases {
		got, err := normalizeOrigin(c.in)
		if err != nil {
			t.Errorf("normalizeOrigin(%q) errored: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("normalizeOrigin(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeOrigin_Invalid(t *testing.T) {
	bad := []string{
		"",
		"   ",
		"no-scheme.example.com",     // missing scheme
		"file:///etc/passwd",        // unsupported scheme
		"ftp://example.com",         // unsupported scheme
		"javascript:alert(1)",       // dangerous scheme
		"https://",                  // no host
	}
	for _, b := range bad {
		if got, err := normalizeOrigin(b); err == nil {
			t.Errorf("normalizeOrigin(%q) should have errored, got %q", b, got)
		}
	}
}

func TestAddAllowedOrigin_Idempotent(t *testing.T) {
	cfg := &config{AllowedOrigins: []string{"https://flowtex.click"}}
	if added := addAllowedOrigin(cfg, "https://latex.example.edu"); !added {
		t.Fatal("first add should return true")
	}
	if added := addAllowedOrigin(cfg, "https://latex.example.edu"); added {
		t.Fatal("duplicate add should return false")
	}
	if len(cfg.AllowedOrigins) != 2 {
		t.Fatalf("expected 2 origins, got %v", cfg.AllowedOrigins)
	}
}

func TestRemoveAllowedOrigin(t *testing.T) {
	cfg := &config{AllowedOrigins: []string{
		"https://flowtex.click",
		"https://latex.example.edu",
		"http://localhost:3001",
	}}
	if removed := removeAllowedOrigin(cfg, "https://latex.example.edu"); !removed {
		t.Fatal("expected removed=true")
	}
	if len(cfg.AllowedOrigins) != 2 {
		t.Fatalf("expected 2 origins, got %v", cfg.AllowedOrigins)
	}
	for _, o := range cfg.AllowedOrigins {
		if o == "https://latex.example.edu" {
			t.Fatal("origin still present after removal")
		}
	}
}

func TestRemoveAllowedOrigin_NotPresent_Noop(t *testing.T) {
	cfg := &config{AllowedOrigins: []string{"https://flowtex.click"}}
	if removed := removeAllowedOrigin(cfg, "https://nope.example.com"); removed {
		t.Fatal("removing absent origin should return false")
	}
	if len(cfg.AllowedOrigins) != 1 {
		t.Fatalf("origin list should be unchanged, got %v", cfg.AllowedOrigins)
	}
}
