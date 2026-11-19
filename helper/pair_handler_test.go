// /pair handler tests for the codeless path. The peer check is
// injected because httptest requests carry a synthetic RemoteAddr with
// no kernel socket behind it.

package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newPairTestServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	cfg := newTestCfg(t)
	// Same location configDir() resolves under the temp HOME, so a
	// later loadConfig() reads back what the handler persisted.
	cfgDir := filepath.Join(dir, ".flowtex-helper")
	cfg.Path = filepath.Join(cfgDir, "config.json")
	cfg.CertFile = filepath.Join(cfgDir, "helper.crt")
	cfg.KeyFile = filepath.Join(cfgDir, "helper.key")
	s, err := newServer(cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("newServer: %v", err)
	}
	return s
}

func openWindow(s *server, codeless bool) {
	s.pair.mu.Lock()
	s.pair.code = "123456"
	s.pair.until = time.Now().Add(60 * time.Second)
	s.pair.codeless = codeless
	s.pair.mu.Unlock()
}

func postPair(s *server, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/pair", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:51378"
	rec := httptest.NewRecorder()
	s.handlePair(rec, req)
	return rec
}

func pairReason(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not JSON: %q", rec.Body.String())
	}
	return body.Reason
}

func TestHandlePair_Codeless_NoWindow(t *testing.T) {
	s := newPairTestServer(t)
	s.peerCheck = func(string, int) (bool, error) {
		t.Fatal("peer check must not run without a window")
		return false, nil
	}
	rec := postPair(s, `{}`)
	if rec.Code != http.StatusForbidden || pairReason(t, rec) != "no_window" {
		t.Fatalf("got %d %q, want 403 no_window", rec.Code, rec.Body.String())
	}
}

func TestHandlePair_Codeless_CodeOnlyWindowIsNotEnough(t *testing.T) {
	s := newPairTestServer(t)
	openWindow(s, false)
	s.peerCheck = func(string, int) (bool, error) { return true, nil }
	rec := postPair(s, `{}`)
	if rec.Code != http.StatusForbidden || pairReason(t, rec) != "no_window" {
		t.Fatalf("got %d %q, want 403 no_window", rec.Code, rec.Body.String())
	}
	// The code path on that window still works.
	if rec := postPair(s, `{"code":"123456"}`); rec.Code != http.StatusOK {
		t.Fatalf("code pair on code-only window: %d %q", rec.Code, rec.Body.String())
	}
}

func TestHandlePair_Codeless_SameUser_IssuesTokenOnce(t *testing.T) {
	s := newPairTestServer(t)
	openWindow(s, true)
	var sawAddr string
	var sawPort int
	s.peerCheck = func(addr string, port int) (bool, error) { sawAddr, sawPort = addr, port; return true, nil }
	before := s.cfg.BearerToken

	rec := postPair(s, `{}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %q, want 200", rec.Code, rec.Body.String())
	}
	if sawAddr != "127.0.0.1:51378" || sawPort != s.cfg.Port {
		t.Fatalf("peer check called with (%q, %d), want (127.0.0.1:51378, %d)", sawAddr, sawPort, s.cfg.Port)
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Token == "" {
		t.Fatalf("no token in response: %q", rec.Body.String())
	}
	if body.Token == before || body.Token != s.cfg.BearerToken {
		t.Fatal("token must be rotated and returned")
	}
	// Persisted: a reload from disk sees the new token.
	reloaded, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if reloaded.BearerToken != body.Token {
		t.Fatal("new token was not persisted to config.json")
	}
	// Single use.
	if rec := postPair(s, `{}`); rec.Code != http.StatusForbidden || pairReason(t, rec) != "no_window" {
		t.Fatalf("second codeless pair: got %d %q, want 403 no_window", rec.Code, rec.Body.String())
	}
}

func TestHandlePair_Codeless_PeerMismatch_RefusesAndKeepsWindow(t *testing.T) {
	s := newPairTestServer(t)
	openWindow(s, true)
	s.peerCheck = func(string, int) (bool, error) { return false, nil }
	before := s.cfg.BearerToken

	rec := postPair(s, `{}`)
	if rec.Code != http.StatusForbidden || pairReason(t, rec) != "peer_mismatch" {
		t.Fatalf("got %d %q, want 403 peer_mismatch", rec.Code, rec.Body.String())
	}
	if s.cfg.BearerToken != before {
		t.Fatal("token must not rotate on a refused pair")
	}
	// The legitimate user can still pair with the code.
	if !s.pair.codelessOpen() {
		t.Fatal("window must stay open after a peer mismatch")
	}
	if rec := postPair(s, `{"code":"123456"}`); rec.Code != http.StatusOK {
		t.Fatalf("code fallback after mismatch: %d %q", rec.Code, rec.Body.String())
	}
}

func TestHandlePair_Codeless_Unsupported(t *testing.T) {
	s := newPairTestServer(t)
	openWindow(s, true)
	s.peerCheck = func(string, int) (bool, error) { return false, errPeerCheckUnsupported }
	rec := postPair(s, `{}`)
	if rec.Code != http.StatusForbidden || pairReason(t, rec) != "unsupported" {
		t.Fatalf("got %d %q, want 403 unsupported", rec.Code, rec.Body.String())
	}
	// Any other lookup failure is also "unsupported" for the client:
	// it must stop polling and show the code field.
	s.peerCheck = func(string, int) (bool, error) { return false, errors.New("lsof: exec: not found") }
	rec = postPair(s, `{}`)
	if rec.Code != http.StatusForbidden || pairReason(t, rec) != "unsupported" {
		t.Fatalf("got %d %q, want 403 unsupported", rec.Code, rec.Body.String())
	}
	if !s.pair.codelessOpen() {
		t.Fatal("window must stay open so the code fallback works")
	}
}

func TestHandlePair_WrongCodeStillPlainText(t *testing.T) {
	// Legacy clients parse the code-path errors as text; keep that.
	s := newPairTestServer(t)
	openWindow(s, true)
	rec := postPair(s, `{"code":"000000"}`)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "wrong code") {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}
