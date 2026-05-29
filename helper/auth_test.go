// Auth + origin middleware tests. These pin the safety-critical
// behaviours: bearer rejection, Host pin, origin allowlist, CORS
// preflight. Any regression here is a security regression.

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestCfg(t *testing.T) *config {
	t.Helper()
	return &config{
		Port:           9876,
		BearerToken:    "deadbeef" + "00000000" + "11111111" + "22222222" + "33333333" + "44444444" + "55555555" + "66666666", // 64 chars
		AllowedOrigins: []string{"https://flowtex.click", "https://localhost:3001"},
	}
}

func okHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok")
}

func TestWithAuth_RejectsMissingBearerWhenRequired(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Host = "127.0.0.1:9876"
	req.Header.Set("Origin", "https://flowtex.click")
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestWithAuth_AcceptsCorrectBearer(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Host = "127.0.0.1:9876"
	req.Header.Set("Origin", "https://flowtex.click")
	req.Header.Set("Authorization", "Bearer "+cfg.BearerToken)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

func TestWithAuth_RejectsWrongBearer(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Host = "127.0.0.1:9876"
	req.Header.Set("Origin", "https://flowtex.click")
	req.Header.Set("Authorization", "Bearer not-the-real-token")
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestWithAuth_RejectsDisallowedOrigin(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Host = "127.0.0.1:9876"
	req.Header.Set("Origin", "https://evil.example.com")
	req.Header.Set("Authorization", "Bearer "+cfg.BearerToken)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func TestWithAuth_RejectsDisallowedHost(t *testing.T) {
	// DNS rebinding defence: even with a valid bearer + allowed origin,
	// requesting via an unfamiliar Host (eg. arbitrary.example.com that
	// the attacker rebinds to 127.0.0.1) should be rejected.
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Host = "arbitrary.example.com"
	req.Header.Set("Origin", "https://flowtex.click")
	req.Header.Set("Authorization", "Bearer "+cfg.BearerToken)
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func TestWithAuth_AcceptsLocalhostHost(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	for _, host := range []string{"127.0.0.1:9876", "localhost:9876", "helper.localhost.flowtex.click:9876"} {
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		req.Host = host
		req.Header.Set("Origin", "https://flowtex.click")
		req.Header.Set("Authorization", "Bearer "+cfg.BearerToken)
		w := httptest.NewRecorder()
		h(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("expected 200 for host %q, got %d", host, w.Code)
		}
	}
}

func TestWithAuth_AllowsHealthWithoutBearer(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, false, okHandler) // requireBearer=false
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Host = "127.0.0.1:9876"
	// Origin is still required even when bearer is not — see L1 fix.
	req.Header.Set("Origin", "https://flowtex.click")
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestWithAuth_RejectsMissingOriginEvenWithoutBearer(t *testing.T) {
	// L1: closes the no-Origin fingerprinting hole. A no-cors image-load
	// (or any cross-origin request that strips Origin) MUST be rejected
	// — even on /health, even though /health is the public liveness
	// probe. The cost is direct browser-bar visits to https://localhost:9876
	// returning 403; that's fine, /health isn't a user-facing endpoint.
	cfg := newTestCfg(t)
	h := withAuth(cfg, false, okHandler) // requireBearer=false (i.e. /health)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Host = "127.0.0.1:9876"
	// Deliberately no Origin header.
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for missing Origin, got %d", w.Code)
	}
}

func TestWithAuth_PreflightOptionsReturnsCORS(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	req := httptest.NewRequest(http.MethodOptions, "/x", nil)
	req.Host = "127.0.0.1:9876"
	req.Header.Set("Origin", "https://flowtex.click")
	w := httptest.NewRecorder()
	h(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://flowtex.click" {
		t.Errorf("preflight ACAO = %q, want flowtex.click", got)
	}
	methods := w.Header().Get("Access-Control-Allow-Methods")
	if !strings.Contains(methods, "POST") {
		t.Errorf("preflight ACAM should advertise POST, got %q", methods)
	}
}

func TestWithAuth_PreflightFromDisallowedOriginReturnsNoCORS(t *testing.T) {
	cfg := newTestCfg(t)
	h := withAuth(cfg, true, okHandler)
	req := httptest.NewRequest(http.MethodOptions, "/x", nil)
	req.Host = "127.0.0.1:9876"
	req.Header.Set("Origin", "https://evil.example.com")
	w := httptest.NewRecorder()
	h(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("preflight should NOT echo disallowed origin, got %q", got)
	}
}
