// Origin normalization + the allow-origin subcommand support.
//
// Self-hosters running FlowTex on their own domain (e.g.
// https://latex.uni.edu) need to add their origin to the helpers
// allowed_origins list. Hand-editing ~/.flowtex-helper/config.json
// works but is friction-y, so we expose:
//
//   flowtex-helper allow-origin https://latex.uni.edu
//
// Idempotent — running twice with the same origin is a no-op.

package main

import (
	"fmt"
	"net/url"
	"strings"
)

// normalizeOrigin returns the canonical form of a user-supplied origin
// (scheme + host[:port], lowercase, no path, no trailing slash) or an
// error if the input isn't a usable origin string.
//
// Examples:
//   "https://latex.uni.edu/"            -> "https://latex.uni.edu"
//   "HTTPS://Latex.UNI.edu"             -> "https://latex.uni.edu"
//   "https://flowtex.click:443/x/y"     -> "https://flowtex.click"  (port stripped if default)
//   "http://localhost:3001"             -> "http://localhost:3001"
//   ""                                  -> error
//   "no-scheme.example.com"             -> error
func normalizeOrigin(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("origin is empty")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("origin must use http or https (got %q)", u.Scheme)
	}
	if u.Host == "" {
		return "", fmt.Errorf("origin has no host")
	}

	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()

	// Strip the default port for each scheme. Keeps "https://flowtex.click"
	// canonical regardless of whether the user typed the port explicitly.
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}

	if port != "" {
		return fmt.Sprintf("%s://%s:%s", scheme, host, port), nil
	}
	return fmt.Sprintf("%s://%s", scheme, host), nil
}

// addAllowedOrigin appends `origin` to cfg.AllowedOrigins if it isn't
// already there (case-sensitive match on the canonical form). Returns
// true if a write happened.
func addAllowedOrigin(cfg *config, origin string) bool {
	for _, existing := range cfg.AllowedOrigins {
		if existing == origin {
			return false
		}
	}
	cfg.AllowedOrigins = append(cfg.AllowedOrigins, origin)
	return true
}

// removeAllowedOrigin removes `origin` from cfg.AllowedOrigins if
// present. Returns true if a write happened.
func removeAllowedOrigin(cfg *config, origin string) bool {
	out := cfg.AllowedOrigins[:0]
	removed := false
	for _, existing := range cfg.AllowedOrigins {
		if existing == origin {
			removed = true
			continue
		}
		out = append(out, existing)
	}
	cfg.AllowedOrigins = out
	return removed
}
