// Local-LLM bridge — proxies a narrow set of writing-assistant tasks
// to a locally-installed Ollama instance. The browser never talks to
// Ollama directly; everything goes through the helper so:
//
//   1. The bearer + Origin + Host pin auth applies (same boundary as
//      /compile). Ollama's own HTTP API has no auth at all — exposing
//      it cross-origin would be a privilege escalation.
//   2. Task templates are server-side. The browser sends "task=write-
//      to-length, input=..., targetWords=50"; the helper builds the
//      system prompt. The browser CANNOT ask Ollama to do anything
//      that doesn't have a hardcoded task here. No prompt injection
//      from the page side; the LLM only sees the user's selected text
//      wrapped in a fixed system prompt.
//   3. Caps live here: input size, output size, concurrent jobs. None
//      of which Ollama enforces.
//
// Ollama default endpoint is http://127.0.0.1:11434 — configurable via
// `llm_base_url` in ~/.flowtex-helper/config.json for users running
// Ollama on a non-default port (still loopback only; a remote URL is
// rejected by validateLLMBaseURL).

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// llmInputMaxChars caps the selected-text input that gets sent to the
// model. Larger selections almost certainly aren't legitimate
// "rephrase this paragraph" inputs and would push the prompt past the
// context window of small local models anyway.
const llmInputMaxChars = 20_000

// llmOutputMaxChars caps how many characters of streamed output we
// forward to the client before forcibly closing the stream. Stops a
// runaway model (or a malicious one shipped via Ollama) from sending
// gigabytes through the SSE channel.
const llmOutputMaxChars = 50_000

// llmRequestTimeout is the wall-clock cap on a single /llm/complete
// call. Local LLMs vary wildly in speed; 5 minutes is generous for the
// slowest CPU-only configs and short enough that a stuck job doesn't
// pin the helper forever.
const llmRequestTimeout = 5 * time.Minute

// validTasks is the closed set of writing tasks the helper will run.
// Adding a new one requires editing this map AND its prompt template
// in buildLLMPrompt — there's no way to slip an unknown task past the
// allowlist via the request body.
var validTasks = map[string]bool{
	"write-to-length": true,
}

type llmStatus struct {
	Available    bool     `json:"available"`
	BaseURL      string   `json:"baseUrl"`
	Models       []string `json:"models"`
	DefaultModel string   `json:"defaultModel,omitempty"`
	Error        string   `json:"error,omitempty"`
}

type llmCompleteRequest struct {
	Model       string `json:"model"`
	Task        string `json:"task"`
	Input       string `json:"input"`
	TargetWords int    `json:"targetWords"`
}

// ollamaTag is one element of Ollama's GET /api/tags response — we
// only care about the model name. Full struct has a lot more (size,
// digest, modified_at, ...) that we deliberately don't expose to the
// browser since it would mean either keeping our shape in sync with
// Ollama or leaking the upstream shape directly.
type ollamaTag struct {
	Name string `json:"name"`
}

type ollamaTagsResponse struct {
	Models []ollamaTag `json:"models"`
}

// ollamaGenerateRequest mirrors the Ollama /api/generate body. Fields
// not set in the request just use Ollama's defaults.
type ollamaGenerateRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	System string `json:"system,omitempty"`
	Stream bool   `json:"stream"`
}

// ollamaGenerateChunk is one frame of Ollama's streaming response.
// {"response": "tok", "done": false} until the last frame which is
// {"response": "", "done": true, ...stats...}.
type ollamaGenerateChunk struct {
	Response string `json:"response"`
	Done     bool   `json:"done"`
}

// llmBaseURL returns the Ollama base URL the helper should talk to.
// Default is loopback Ollama (http://127.0.0.1:11434); operators can
// override via `llm_base_url` in config.json. Non-loopback URLs are
// rejected so a hand-edited config can't accidentally point the helper
// at a remote endpoint that would leak the user's text off-machine.
func llmBaseURL(cfg *config) (string, error) {
	raw := strings.TrimSpace(cfg.LLMBaseURL)
	if raw == "" {
		raw = "http://127.0.0.1:11434"
	}
	if err := validateLLMBaseURL(raw); err != nil {
		return "", err
	}
	return strings.TrimRight(raw, "/"), nil
}

// validateLLMBaseURL refuses anything that isn't http(s)://loopback.
// "Loopback" = literal 127.0.0.1, ::1, or hostname `localhost`. This
// is the defence against a hand-edited config silently exfiltrating
// the user's writing to a remote inference service.
func validateLLMBaseURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("scheme must be http or https (got %q)", u.Scheme)
	}
	host := u.Hostname()
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("host %q is not loopback (LLM URL must point at the local machine)", host)
}

// detectOllama probes the configured Ollama endpoint and returns the
// list of available models. Returns ([], err) if Ollama isn't running
// or the response shape is unexpected.
func detectOllama(ctx context.Context, cfg *config) ([]string, error) {
	base, err := llmBaseURL(cfg)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/tags", nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama returned %d", res.StatusCode)
	}
	var tags ollamaTagsResponse
	if err := json.NewDecoder(res.Body).Decode(&tags); err != nil {
		return nil, fmt.Errorf("decode tags: %w", err)
	}
	out := make([]string, 0, len(tags.Models))
	for _, m := range tags.Models {
		if m.Name != "" {
			out = append(out, m.Name)
		}
	}
	return out, nil
}

// buildLLMPrompt assembles the (system, user) prompt pair for a given
// task. Every task's prompt template lives here so review is a single
// file — and so a new task can't be added by the client side alone.
func buildLLMPrompt(req *llmCompleteRequest) (system, user string, err error) {
	if !validTasks[req.Task] {
		return "", "", fmt.Errorf("unsupported task %q", req.Task)
	}
	switch req.Task {
	case "write-to-length":
		if req.TargetWords < 1 || req.TargetWords > 2000 {
			return "", "", fmt.Errorf("targetWords must be between 1 and 2000")
		}
		system = "You are a writing assistant inside a LaTeX editor. " +
			"You rewrite the user's selected text to match a target word count " +
			"while preserving meaning, tone, and any LaTeX commands. " +
			"Respond ONLY with the rewritten text — no preamble, no quotes, " +
			"no explanations, no markdown fences."
		user = fmt.Sprintf(
			"Rewrite the following text to be approximately %d words. "+
				"Keep the meaning and any LaTeX markup intact.\n\n---\n%s\n---",
			req.TargetWords, req.Input,
		)
	}
	return system, user, nil
}

// streamOllamaComplete posts to Ollama's /api/generate and forwards each
// streamed chunk to `onDelta`. Stops on context cancellation, output
// cap exhaustion, or stream end. The output cap is enforced even if
// the model never sets done=true.
func streamOllamaComplete(ctx context.Context, cfg *config, req *llmCompleteRequest, onDelta func(string) error) error {
	system, user, err := buildLLMPrompt(req)
	if err != nil {
		return err
	}
	base, err := llmBaseURL(cfg)
	if err != nil {
		return err
	}
	body, err := json.Marshal(ollamaGenerateRequest{
		Model:  req.Model,
		Prompt: user,
		System: system,
		Stream: true,
	})
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// No timeout on the underlying client — context governs the deadline.
	client := &http.Client{}
	res, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("ollama request: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		preview, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("ollama returned %d: %s", res.StatusCode, strings.TrimSpace(string(preview)))
	}

	scanner := bufio.NewScanner(res.Body)
	// Ollama frames can be longer than the default 64 KiB scanner buffer
	// on big completions — set a generous cap that still bounds memory.
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	totalChars := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var chunk ollamaGenerateChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			continue // skip malformed frames rather than aborting the whole stream
		}
		if chunk.Response != "" {
			// Truncate if we'd overshoot the cap mid-chunk.
			remaining := llmOutputMaxChars - totalChars
			if remaining <= 0 {
				return errors.New("output cap reached")
			}
			out := chunk.Response
			if len(out) > remaining {
				out = out[:remaining]
			}
			totalChars += len(out)
			if err := onDelta(out); err != nil {
				return err
			}
			if totalChars >= llmOutputMaxChars {
				return errors.New("output cap reached")
			}
		}
		if chunk.Done {
			return nil
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read stream: %w", err)
	}
	return nil
}
