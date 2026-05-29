// HTTP handlers wired up. Each endpoint runs through `withAuth` which
// enforces origin allowlist, Host pin, and (for state-mutating routes)
// the bearer token. /health and /pair are deliberately exempt from the
// bearer check — see their handler comments.

package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
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
	// compileLimiter caps both the burst rate AND the peak number of
	// concurrent compiles. Defense against a stolen-bearer attacker
	// pinning the user's CPU / filling /tmp with parallel latexmk
	// processes. Sized for a single-user dev tool — see compileSlots /
	// compileRateBurst constants.
	compileLimiter *compileLimiter
	// llmLimiter has tighter caps than compile — local LLM inference
	// is single-GPU-bound; parallel requests don't go faster, they
	// just queue. Limit to 1 in-flight with a modest rate cap to
	// blunt accidental-spam from a stuck client retry loop.
	llmLimiter *compileLimiter
}

// Concurrency + rate-limit budget for /compile. The helper is single-user;
// a paired browser tab in normal use compiles at most ~1/s and never has
// more than 1-2 in flight. These bounds give legit usage plenty of room
// while a runaway attacker hits the wall fast.
const compileSlots = 2     // hard cap on parallel latexmk processes
const compileRateBurst = 3 // burst tolerance (e.g. user clicks Compile twice)
const compileRatePerMin = 60

// LLM budget: tighter than compile. One in-flight is the right number
// because the model is single-GPU/CPU-bound — extra concurrency just
// queues. Rate is per-minute so a runaway client (stuck retry loop)
// hits a wall fast.
const llmSlots = 1
const llmRateBurst = 2
const llmRatePerMin = 30

func newServer(cfg *config, logger *log.Logger) (*server, error) {
	s := &server{
		cfg:            cfg,
		logger:         logger,
		pair:           newPairStore(),
		jobs:           newJobRegistry(),
		compileLimiter: newCompileLimiter(compileSlots, compileRateBurst, compileRatePerMin),
		llmLimiter:     newCompileLimiter(llmSlots, llmRateBurst, llmRatePerMin),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", withAuth(cfg, false, s.handleHealth))
	mux.HandleFunc("/version", withAuth(cfg, true, s.handleVersion))
	mux.HandleFunc("/pair", withAuth(cfg, false, s.handlePair))
	mux.HandleFunc("/compile", withAuth(cfg, true, s.handleCompile))
	mux.HandleFunc("/cancel/", withAuth(cfg, true, s.handleCancel))
	mux.HandleFunc("/llm/status", withAuth(cfg, true, s.handleLLMStatus))
	mux.HandleFunc("/llm/complete", withAuth(cfg, true, s.handleLLMComplete))

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

// /pair — unauthenticated POST with JSON body `{"code":"NNNNNN"}`.
// (Legacy ?code= query param still accepted for backwards-compat with
// older browser clients; will be dropped in a future release.) Validates
// the 6-digit code against an active pairing window (opened by
// `flowtex-helper pair`), and on success returns the current bearer
// token. The token is also rotated here so a previously-paired browser
// is implicitly de-auth'd — pairing a new browser invalidates the old
// one, which is the conservative default.
//
// Why prefer the body over the query: codes in URLs leak into Referer
// headers, browser DevTools history, and any verbose logging — the
// window is 60s + single-use so the practical risk is small, but a
// request body is the right channel for a credential-like value.
func (s *server) handlePair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Prefer the body. Fall through to the legacy query string only if
	// the body is empty or missing — minimises surprise during the
	// deprecation window.
	code := ""
	if r.Body != nil {
		// Tiny body cap — a 6-digit code is 32 bytes wrapped; 256 is
		// plenty to absorb whitespace / Content-Type quirks.
		r.Body = http.MaxBytesReader(w, r.Body, 256)
		defer r.Body.Close()
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
			code = body.Code
		}
	}
	if code == "" {
		code = r.URL.Query().Get("code")
	}
	if code == "" {
		http.Error(w, "code required (POST body {\"code\":\"NNNNNN\"})", http.StatusBadRequest)
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
//
// Rate-limit + concurrency-cap defence: see compileLimiter. M2 fix
// from the helper security audit. If the user is over budget the
// response is 429 with a Retry-After header.
func (s *server) handleCompile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if wait, ok := s.compileLimiter.allow(); !ok {
		// Tell the caller how long to wait before retrying — Retry-After
		// is in seconds, rounded up so we never tell them to retry
		// before the bucket actually has a token.
		secs := int((wait + time.Second - 1) / time.Second)
		if secs < 1 {
			secs = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	// Acquire a concurrency slot, blocking up to a short timeout. If
	// none free up, reject — better to fast-fail than queue indefinitely
	// while the request body sits in memory.
	acqCtx, acqCancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer acqCancel()
	if !s.compileLimiter.acquireSlot(acqCtx) {
		w.Header().Set("Retry-After", "10")
		http.Error(w, "too many concurrent compiles", http.StatusTooManyRequests)
		return
	}
	defer s.compileLimiter.releaseSlot()

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

// /llm/status — authenticated GET. Probes the configured local LLM
// runtime (Ollama) and reports availability + model list. Does NOT
// return any user-text data. Used by the client to decide whether to
// enable LLM-driven menu items and to populate the model picker.
func (s *server) handleLLMStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	status := llmStatus{}
	base, err := llmBaseURL(s.cfg)
	if err != nil {
		status.Error = "invalid LLM base URL in config: " + err.Error()
		writeJSON(w, status)
		return
	}
	status.BaseURL = base
	status.DefaultModel = s.cfg.LLMDefaultModel
	models, err := detectOllama(ctx, s.cfg)
	if err != nil {
		status.Error = err.Error()
		writeJSON(w, status)
		return
	}
	status.Available = true
	status.Models = models
	writeJSON(w, status)
}

// /llm/complete — authenticated POST. Streams a single LLM completion
// for one of the predefined writing tasks. SSE response: each `data:`
// frame is a JSON object {"delta":"text"}; the final frame is
// {"done":true} or {"error":"..."}.
//
// Why SSE: local LLMs are slow (5-30s typical), and the UX is
// dramatically better when the user sees tokens stream in. SSE plays
// nicely with the EventSource API and survives any reverse proxy /
// loopback bridge plumbing without HTTP/2 specifics.
func (s *server) handleLLMComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if wait, ok := s.llmLimiter.allow(); !ok {
		secs := int((wait + time.Second - 1) / time.Second)
		if secs < 1 {
			secs = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}
	acqCtx, acqCancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer acqCancel()
	if !s.llmLimiter.acquireSlot(acqCtx) {
		w.Header().Set("Retry-After", "10")
		http.Error(w, "too many concurrent LLM requests", http.StatusTooManyRequests)
		return
	}
	defer s.llmLimiter.releaseSlot()

	r.Body = http.MaxBytesReader(w, r.Body, llmInputMaxChars+1024)
	defer r.Body.Close()
	var req llmCompleteRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "bad request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(req.Input) == 0 {
		http.Error(w, "input is required", http.StatusBadRequest)
		return
	}
	if len(req.Input) > llmInputMaxChars {
		http.Error(w, "input too large", http.StatusRequestEntityTooLarge)
		return
	}
	if !validTasks[req.Task] {
		http.Error(w, "unknown task", http.StatusBadRequest)
		return
	}
	if req.Model == "" {
		req.Model = s.cfg.LLMDefaultModel
	}
	if req.Model == "" {
		http.Error(w, "model is required (no default configured)", http.StatusBadRequest)
		return
	}
	if err := validateOllamaModelName(req.Model); err != nil {
		http.Error(w, "invalid model name: "+err.Error(), http.StatusBadRequest)
		return
	}

	// SSE headers. Disable any intermediate buffering — we want the
	// client to see each chunk as it lands.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, _ := w.(http.Flusher)
	if flusher == nil {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)

	ctx, cancel := context.WithTimeout(r.Context(), llmRequestTimeout)
	defer cancel()

	emit := func(payload map[string]any) {
		b, err := json.Marshal(payload)
		if err != nil {
			return
		}
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}

	err := streamOllamaComplete(ctx, s.cfg, &req, func(delta string) error {
		emit(map[string]any{"delta": delta})
		return nil
	})
	if err != nil {
		// Don't leak prompt/response data — error string is the
		// runtime error class only.
		emit(map[string]any{"error": err.Error()})
		return
	}
	emit(map[string]any{"done": true})
}

// writeJSON is a tiny convenience for the status endpoint.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
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

// compileLimiter combines a token-bucket rate limiter with a
// concurrency semaphore. Both have to admit a request for it to run.
//
// Why both: the rate limit prevents a burst (1000 /compile in a second
// even if each finishes fast), and the slot semaphore prevents pile-up
// of slow compiles (each takes up to 90s and runs latexmk).
type compileLimiter struct {
	// Slots: simple buffered channel as semaphore.
	slots chan struct{}

	// Bucket: token-bucket state. refilledAt is the last time we
	// refilled the bucket; tokens is the current count, capped at
	// burst. ratePerMin is the steady-state replenishment rate. Lock
	// guards all three.
	mu         sync.Mutex
	tokens     float64
	burst      float64
	ratePerMin float64
	refilledAt time.Time
}

func newCompileLimiter(slots, burst, ratePerMin int) *compileLimiter {
	c := &compileLimiter{
		slots:      make(chan struct{}, slots),
		tokens:     float64(burst),
		burst:      float64(burst),
		ratePerMin: float64(ratePerMin),
		refilledAt: time.Now(),
	}
	return c
}

// allow consumes a token from the rate bucket if one is available,
// returning (0, true) on admit and (waitDuration, false) on reject.
// waitDuration is how long the caller should wait before retrying for
// guaranteed admission.
func (c *compileLimiter) allow() (time.Duration, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	elapsed := now.Sub(c.refilledAt).Seconds()
	c.tokens += elapsed * c.ratePerMin / 60.0
	if c.tokens > c.burst {
		c.tokens = c.burst
	}
	c.refilledAt = now
	if c.tokens >= 1 {
		c.tokens--
		return 0, true
	}
	// Need (1 - tokens) more tokens; rate is tokens/sec.
	needed := 1.0 - c.tokens
	secs := needed * 60.0 / c.ratePerMin
	return time.Duration(secs * float64(time.Second)), false
}

// acquireSlot blocks up to the context deadline waiting for a free
// concurrency slot. Returns true on acquisition; false if the context
// expired first.
func (c *compileLimiter) acquireSlot(ctx context.Context) bool {
	select {
	case c.slots <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (c *compileLimiter) releaseSlot() {
	<-c.slots
}
