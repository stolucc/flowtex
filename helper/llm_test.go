// Tests for the local-LLM bridge. Cover the security-critical bits:
// loopback-only URL validation, task allowlist enforcement, target-
// length bounds, output cap, Ollama stream parsing. The actual model
// inference is faked with an httptest.Server so these tests run with
// no external dependency.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestValidateLLMBaseURL_AcceptsLoopback(t *testing.T) {
	cases := []string{
		"http://127.0.0.1:11434",
		"http://localhost:11434",
		"http://[::1]:11434",
		"https://127.0.0.1:9999",
	}
	for _, c := range cases {
		if err := validateLLMBaseURL(c); err != nil {
			t.Errorf("expected %q to be accepted, got: %v", c, err)
		}
	}
}

func TestValidateLLMBaseURL_RejectsRemote(t *testing.T) {
	// A hand-edited config pointing the helper at a remote inference
	// service would exfiltrate every selected text snippet. This
	// boundary is load-bearing for the "local only" guarantee.
	cases := []string{
		"http://example.com:11434",
		"https://api.openai.com",
		"http://192.168.1.50:11434",
		"http://8.8.8.8",
		"http://my-laptop.local",
		"ftp://127.0.0.1",
		"not a url at all !!!",
	}
	for _, c := range cases {
		if err := validateLLMBaseURL(c); err == nil {
			t.Errorf("expected %q to be REJECTED, got nil err", c)
		}
	}
}

func TestValidateOllamaModelName_AcceptsRealOllamaTags(t *testing.T) {
	good := []string{
		"llama3.2:3b",
		"qwen2.5:7b",
		"library/llama3.1:8b-instruct-q4_K_M",
		"nomic-embed-text:latest",
		"phi3",
		"mxbai-embed-large:335m",
	}
	for _, n := range good {
		if err := validateOllamaModelName(n); err != nil {
			t.Errorf("expected %q to be accepted, got %v", n, err)
		}
	}
}

func TestValidateOllamaModelName_RejectsPathological(t *testing.T) {
	bad := []string{
		"",
		"contains space",
		"emoji-😀",
		"new\nline",
		"semi;colon",
		"$(injection)",
		strings.Repeat("x", 129), // over 128-byte cap
	}
	for _, n := range bad {
		if err := validateOllamaModelName(n); err == nil {
			t.Errorf("expected %q to be REJECTED, got nil", n)
		}
	}
}

func TestLoopbackClient_RefusesToFollowRedirects(t *testing.T) {
	// M-NEW-1: a process posing as Ollama could 302 → http://evil.com
	// and exfiltrate the user's selected text BEFORE we check status.
	// The CheckRedirect override returns ErrUseLastResponse so the
	// 30x response is surfaced to the caller as-is.
	var hits int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		http.Redirect(w, r, "http://example.invalid/should-not-be-followed", http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := loopbackClient(2 * time.Second)
	req, _ := http.NewRequest("POST", srv.URL+"/api/generate", strings.NewReader(`{}`))
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("expected response, not error: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Errorf("expected 302 to surface, got %d (redirect was followed)", res.StatusCode)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("expected exactly 1 hit (no follow-up to evil URL), got %d", got)
	}
}

func TestBuildLLMPrompt_RejectsUnknownTask(t *testing.T) {
	// Task allowlist is the gate against prompt injection from the
	// browser. Only tasks with a hardcoded template in this file run.
	_, _, err := buildLLMPrompt(&llmCompleteRequest{Task: "evil-task", Input: "x", TargetWords: 50})
	if err == nil {
		t.Fatal("unknown task should produce an error")
	}
}

func TestBuildLLMPrompt_WriteToLength_BoundsTargetWords(t *testing.T) {
	for _, bad := range []int{0, -1, 9999, 100000} {
		_, _, err := buildLLMPrompt(&llmCompleteRequest{
			Task: "write-to-length", Input: "hi", TargetWords: bad,
		})
		if err == nil {
			t.Errorf("targetWords=%d should be rejected", bad)
		}
	}
	for _, good := range []int{1, 50, 500, 2000} {
		_, _, err := buildLLMPrompt(&llmCompleteRequest{
			Task: "write-to-length", Input: "hi", TargetWords: good,
		})
		if err != nil {
			t.Errorf("targetWords=%d should be accepted, got %v", good, err)
		}
	}
}

func TestBuildLLMPrompt_WriteToLength_Shape(t *testing.T) {
	system, user, err := buildLLMPrompt(&llmCompleteRequest{
		Task: "write-to-length", Input: "Hello world.", TargetWords: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	// System prompt must instruct the model to return ONLY the
	// rewritten text — otherwise the preview pane fills up with the
	// model's chatter. Cheap regression guard.
	if !strings.Contains(system, "ONLY") || !strings.Contains(system, "no preamble") {
		t.Errorf("system prompt missing 'ONLY' constraints: %s", system)
	}
	if !strings.Contains(user, "42 words") {
		t.Errorf("user prompt missing target word count: %s", user)
	}
	if !strings.Contains(user, "Hello world.") {
		t.Errorf("user prompt missing input text: %s", user)
	}
}

func TestBuildLLMPrompt_AllTasksHaveTemplates(t *testing.T) {
	// Every task in validTasks MUST have a template branch in
	// buildLLMPrompt — otherwise the switch falls through and we
	// return ("", "", nil), which would send an EMPTY prompt to
	// Ollama. Walk the map and ensure each one produces non-empty
	// strings. Some tasks need extra fields (write-to-length wants
	// TargetWords, custom wants Instruction); supply both so this
	// check is purely about template presence, not validation.
	for task := range validTasks {
		req := &llmCompleteRequest{
			Task:        task,
			Input:       "Sample text.",
			TargetWords: 50,
			Instruction: "Translate this to formal English.",
		}
		system, user, err := buildLLMPrompt(req)
		if err != nil {
			t.Errorf("task %q: unexpected error: %v", task, err)
			continue
		}
		if system == "" {
			t.Errorf("task %q: empty system prompt", task)
		}
		if user == "" {
			t.Errorf("task %q: empty user prompt", task)
		}
		// Every task should refuse preambles so the preview pane
		// shows only the output.
		if !strings.Contains(system, "ONLY") {
			t.Errorf("task %q: system prompt missing 'ONLY' guard", task)
		}
	}
}

func TestBuildLLMPrompt_Custom_RejectsEmptyInstruction(t *testing.T) {
	_, _, err := buildLLMPrompt(&llmCompleteRequest{
		Task: "custom", Input: "hi", Instruction: "",
	})
	if err == nil {
		t.Fatal("empty instruction should produce an error")
	}
}

func TestBuildLLMPrompt_Custom_RejectsOversizedInstruction(t *testing.T) {
	_, _, err := buildLLMPrompt(&llmCompleteRequest{
		Task:        "custom",
		Input:       "hi",
		Instruction: strings.Repeat("x", llmInstructionMaxChars+1),
	})
	if err == nil {
		t.Fatal("oversized instruction should produce an error")
	}
}

func TestBuildLLMPrompt_Custom_HardenedSystemPrompt(t *testing.T) {
	// The custom task is the only one where the user controls part of
	// the prompt directly. The system prompt MUST carry the textual-
	// only constraint and the refusal sentinel so future edits don't
	// accidentally weaken it.
	system, user, err := buildLLMPrompt(&llmCompleteRequest{
		Task: "custom", Input: "Sample.", Instruction: "Make it shorter.",
	})
	if err != nil {
		t.Fatal(err)
	}
	wantSystem := []string{
		"TEXTUAL TRANSFORMATION",
		"MUST NOT generate",
		"\\write18",
		"\\directlua",
		"Cannot perform that operation",
	}
	for _, s := range wantSystem {
		if !strings.Contains(system, s) {
			t.Errorf("custom system prompt missing %q", s)
		}
	}
	if !strings.Contains(user, "INSTRUCTION") || !strings.Contains(user, "SELECTED TEXT") {
		t.Errorf("custom user prompt missing INSTRUCTION/SELECTED TEXT sections: %s", user)
	}
	if !strings.Contains(user, "Make it shorter.") {
		t.Errorf("custom user prompt didn't include the user's instruction")
	}
}

func TestBuildLLMPrompt_NewTasksMentionItemize(t *testing.T) {
	// itemize must produce a LaTeX itemize environment; write-it-out
	// must strip the itemize/\\item markup. These prompt-shape
	// regressions are easy to introduce silently; pin them.
	system, user, err := buildLLMPrompt(&llmCompleteRequest{
		Task: "itemize", Input: "Three things happened.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(user, "itemize") || !strings.Contains(user, "\\item") {
		t.Errorf("itemize prompt should reference itemize + \\item: %s", user)
	}
	_ = system

	system, user, err = buildLLMPrompt(&llmCompleteRequest{
		Task: "write-it-out", Input: "\\begin{itemize}\\item A\\end{itemize}",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(user, "prose paragraph") {
		t.Errorf("write-it-out prompt should ask for a prose paragraph: %s", user)
	}
	_ = system
}

// fakeOllama spins up an httptest.Server that mimics the Ollama API
// surface we need (/api/tags and /api/generate). Returns a cleanup
// func plus the cfg pointing at the fake.
func fakeOllama(t *testing.T, models []string, generateChunks []string) (*config, func()) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		out := ollamaTagsResponse{}
		for _, m := range models {
			out.Models = append(out.Models, ollamaTag{Name: m})
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		// Ollama framing: one JSON object per line, last has done=true.
		w.Header().Set("Content-Type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		for _, chunk := range generateChunks {
			line := fmt.Sprintf(`{"response":%q,"done":false}`+"\n", chunk)
			_, _ = w.Write([]byte(line))
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = w.Write([]byte(`{"response":"","done":true}` + "\n"))
	})
	srv := httptest.NewServer(mux)
	// httptest's URL is http://127.0.0.1:RANDOM_PORT — passes
	// validateLLMBaseURL because the host is 127.0.0.1.
	cfg := &config{LLMBaseURL: srv.URL}
	return cfg, srv.Close
}

func TestDetectOllama_ReturnsModelList(t *testing.T) {
	cfg, cleanup := fakeOllama(t, []string{"llama3:8b", "qwen2:7b"}, nil)
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	models, err := detectOllama(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0] != "llama3:8b" || models[1] != "qwen2:7b" {
		t.Fatalf("unexpected models: %v", models)
	}
}

func TestDetectOllama_ErrorsWhenUnreachable(t *testing.T) {
	cfg := &config{LLMBaseURL: "http://127.0.0.1:1"} // port 1: unreachable
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	if _, err := detectOllama(ctx, cfg); err == nil {
		t.Fatal("expected error from unreachable endpoint")
	}
}

func TestStreamOllamaComplete_ForwardsDeltas(t *testing.T) {
	cfg, cleanup := fakeOllama(t, []string{"m"}, []string{"Hello ", "world", "."})
	defer cleanup()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var collected strings.Builder
	err := streamOllamaComplete(ctx, cfg, &llmCompleteRequest{
		Task: "write-to-length", Model: "m", Input: "hi", TargetWords: 5,
	}, func(d string) error {
		collected.WriteString(d)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := collected.String(); got != "Hello world." {
		t.Fatalf("unexpected output: %q", got)
	}
}

func TestStreamOllamaComplete_RespectsContextCancel(t *testing.T) {
	// A slow-emitting fake: pause between chunks so we can cancel
	// mid-stream and verify the stream returns promptly.
	mux := http.NewServeMux()
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 100; i++ {
			line := fmt.Sprintf(`{"response":"t","done":false}` + "\n")
			_, _ = w.Write([]byte(line))
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cfg := &config{LLMBaseURL: srv.URL}

	ctx, cancel := context.WithCancel(context.Background())
	var count int32
	go func() {
		time.Sleep(120 * time.Millisecond)
		cancel()
	}()
	err := streamOllamaComplete(ctx, cfg, &llmCompleteRequest{
		Task: "write-to-length", Model: "m", Input: "hi", TargetWords: 5,
	}, func(d string) error {
		atomic.AddInt32(&count, 1)
		return nil
	})
	if err == nil {
		t.Fatal("expected an error after context cancellation")
	}
	// Should have got a few chunks but not all 100.
	if c := atomic.LoadInt32(&count); c == 0 || c >= 100 {
		t.Errorf("expected partial stream (1..99 chunks), got %d", c)
	}
}

func TestStreamOllamaComplete_EnforcesOutputCap(t *testing.T) {
	// Feed a single chunk longer than the cap; expect the callback
	// gets at most llmOutputMaxChars total then the stream aborts.
	bigPayload := strings.Repeat("x", llmOutputMaxChars+1000)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/generate", func(w http.ResponseWriter, r *http.Request) {
		line := fmt.Sprintf(`{"response":%q,"done":false}`+"\n", bigPayload)
		_, _ = w.Write([]byte(line))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	cfg := &config{LLMBaseURL: srv.URL}

	var total int
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := streamOllamaComplete(ctx, cfg, &llmCompleteRequest{
		Task: "write-to-length", Model: "m", Input: "hi", TargetWords: 5,
	}, func(d string) error {
		total += len(d)
		return nil
	})
	if err == nil {
		t.Fatal("expected output-cap error")
	}
	if total > llmOutputMaxChars {
		t.Errorf("output cap not enforced: got %d chars (cap %d)", total, llmOutputMaxChars)
	}
}
