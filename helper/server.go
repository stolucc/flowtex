// HTTP handlers wired up. Each endpoint runs through `withAuth` which
// enforces origin allowlist, Host pin, and (for state-mutating routes)
// the bearer token. /health and /pair are deliberately exempt from the
// bearer check — see their handler comments.

package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type server struct {
	HTTP   *http.Server
	cfg    *config
	logger *log.Logger
	pair   *pairStore
	jobs   *jobRegistry
}

func newServer(cfg *config, logger *log.Logger) (*server, error) {
	s := &server{
		cfg:    cfg,
		logger: logger,
		pair:   newPairStore(),
		jobs:   newJobRegistry(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", withAuth(cfg, false, s.handleHealth))
	mux.HandleFunc("/version", withAuth(cfg, true, s.handleVersion))
	mux.HandleFunc("/pair", withAuth(cfg, false, s.handlePair))
	mux.HandleFunc("/compile", withAuth(cfg, true, s.handleCompile))
	mux.HandleFunc("/cancel/", withAuth(cfg, true, s.handleCancel))

	// Bind to 127.0.0.1 ONLY. The lifecycle of the listener is owned by
	// the http.Server, not the listener config, so the Addr field is
	// just informational here — the explicit Listen below is what binds.
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port))

	s.HTTP = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       2 * time.Minute,  // big projects -> larger uploads
		WriteTimeout:      0,                 // 0 = no deadline; compile path can run up to compileTimeout
		IdleTimeout:       60 * time.Second,
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	}

	// Pairing-window poller. 1Hz is plenty; the window is 60s.
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			s.pair.loadFromFile()
		}
	}()

	return s, nil
}

// /health — unauthenticated, just a liveness probe. Returning version
// info would help a hostile site fingerprint the install; we keep the
// body intentionally minimal.
func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, `{"ok":true}`)
}

// /version — authenticated. Tells the paired browser the helper's TeX
// Live year + which engines / biber are available, so the client can
// match against the projects pinned tex_distribution.
func (s *server) handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	info := detectTex()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(info)
}

// /pair?code=NNNNNN — unauthenticated POST. Validates the 6-digit code
// against an active pairing window (opened by `flowtex-helper pair`),
// and on success returns the current bearer token. The token is also
// rotated here so a previously-paired browser is implicitly de-auth'd
// — pairing a new browser invalidates the old one, which is the
// conservative default.
func (s *server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "code query param required", http.StatusBadRequest)
		return
	}
	if !s.pair.consume(code) {
		http.Error(w, "no pairing window open, or wrong code", http.StatusForbidden)
		return
	}
	// Rotate the token so previously-paired browsers stop working.
	s.cfg.BearerToken = generateToken()
	if err := saveConfig(s.cfg); err != nil {
		s.logger.Printf("save config after pair: %v", err)
		http.Error(w, "failed to persist new token", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"token": s.cfg.BearerToken})
}

// compileMaxBodyBytes caps the JSON payload accepted by /compile. The
// helper runs on the user's own machine, so the threat model is mostly
// "a paired browser page that's been compromised tries to fill the
// disk" — but defense in depth: TeX projects routinely sit comfortably
// under a few MB even with images base64-inlined. 64 MB is generous
// for legitimate projects and small enough to short-circuit obvious
// abuse before we hit os.WriteFile per file.
const compileMaxBodyBytes = 64 << 20 // 64 MiB

// /compile — authenticated POST. Body shape: compileRequest. Blocks
// until the compile finishes, then returns compileResponse (with
// base64-encoded PDF). Cancellation: a sibling POST to /cancel/:jobId
// signals the running compile via context.
func (s *server) handleCompile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, compileMaxBodyBytes)
	defer r.Body.Close()
	var req compileRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "bad request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.JobID == "" {
		http.Error(w, "jobId required", http.StatusBadRequest)
		return
	}

	// Per-job cancellation: store a cancel-fn keyed by jobId so /cancel
	// can trip the context if the user clicks Stop.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.jobs.register(req.JobID, cancel)
	defer s.jobs.deregister(req.JobID)

	resp := runCompile(ctx, s.cfg, &req)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// /cancel/:jobId — authenticated POST. Trips the in-flight compile.
func (s *server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	jobID := r.URL.Path[len("/cancel/"):]
	if jobID == "" {
		http.Error(w, "jobId required in URL", http.StatusBadRequest)
		return
	}
	if !s.jobs.cancel(jobID) {
		// 404 vs 200 doesn't really matter here, but be honest.
		http.Error(w, "no such job", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// jobRegistry — lookup table from jobId → cancel func. Compile handlers
// register on entry and deregister on exit; cancel handler trips by id.
type jobRegistry struct {
	mu   sync.Mutex
	jobs map[string]context.CancelFunc
}

func newJobRegistry() *jobRegistry {
	return &jobRegistry{jobs: make(map[string]context.CancelFunc)}
}

func (j *jobRegistry) register(id string, c context.CancelFunc) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.jobs[id] = c
}

func (j *jobRegistry) deregister(id string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	delete(j.jobs, id)
}

func (j *jobRegistry) cancel(id string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	c, ok := j.jobs[id]
	if !ok {
		return false
	}
	c()
	delete(j.jobs, id)
	return true
}
