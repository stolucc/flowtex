// Auth + origin middleware.
//
// Three layers run before any handler that touches state:
//
//  1. Method whitelist (handler-level, not here — each handler declares
//     its allowed methods).
//  2. Origin allowlist (this file). Only browser pages served from a
//     URL in cfg.AllowedOrigins can talk to the helper. The Host header
//     is also pinned to localhost / 127.0.0.1 / helper.localhost.flowtex.click
//     to thwart DNS-rebinding attacks against the loopback listener.
//  3. Bearer token (this file). Constant-time compare against
//     cfg.BearerToken. Missing or wrong → 401.
//
// /health and /pair are intentionally exempt from bearer auth — see the
// handler comments for why.

package main

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// allowedHosts is the set of values we accept in the Host header. The
// helper binds to 127.0.0.1 so in principle Host is whatever the client
// chose to put in there — a DNS-rebinding attacker could resolve
// arbitrary.example.com to 127.0.0.1 and trick the user into hitting
// the helper. Enforcing Host equality kills that vector.
func allowedHosts(port int) []string {
	return []string{
		// Browsers strip the default-for-scheme port from Host, but for
		// non-default ports (9876) the port is always included.
		"127.0.0.1:" + portString(port),
		"localhost:" + portString(port),
		"helper.localhost.flowtex.click:" + portString(port),
	}
}

func portString(p int) string {
	// Avoid pulling in strconv just for this one place. Simple enough.
	if p == 0 {
		return "0"
	}
	out := ""
	for p > 0 {
		out = string(rune('0'+p%10)) + out
		p /= 10
	}
	return out
}

// withAuth wraps a handler with origin + Host + bearer enforcement.
// Pass requireBearer=false for the /health probe and /pair handshake.
func withAuth(cfg *config, requireBearer bool, h http.HandlerFunc) http.HandlerFunc {
	hosts := allowedHosts(cfg.Port)
	return func(w http.ResponseWriter, r *http.Request) {
		// CORS preflight: many browsers send OPTIONS before POST. Respond
		// with the same allowlist + Authorization header so the actual
		// request goes through.
		if r.Method == http.MethodOptions {
			origin := r.Header.Get("Origin")
			if originAllowed(cfg, origin) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Host pin.
		host := r.Host
		hostOK := false
		for _, h := range hosts {
			if strings.EqualFold(host, h) {
				hostOK = true
				break
			}
		}
		if !hostOK {
			http.Error(w, "host not allowed", http.StatusForbidden)
			return
		}

		// Origin allowlist (skip when there is no Origin header, e.g.
		// direct browser-bar navigation to /health).
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !originAllowed(cfg, origin) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "false")
			w.Header().Set("Vary", "Origin")
		}

		// Bearer token (when required).
		if requireBearer {
			auth := r.Header.Get("Authorization")
			const prefix = "Bearer "
			if !strings.HasPrefix(auth, prefix) {
				http.Error(w, "missing bearer token", http.StatusUnauthorized)
				return
			}
			provided := auth[len(prefix):]
			// constant-time compare to avoid timing attacks revealing
			// partial token matches over the network.
			if subtle.ConstantTimeCompare([]byte(provided), []byte(cfg.BearerToken)) != 1 {
				http.Error(w, "invalid bearer token", http.StatusUnauthorized)
				return
			}
		}

		h(w, r)
	}
}

func originAllowed(cfg *config, origin string) bool {
	for _, allowed := range cfg.AllowedOrigins {
		if strings.EqualFold(origin, allowed) {
			return true
		}
	}
	return false
}
