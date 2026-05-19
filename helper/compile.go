// compile.go — local LaTeX compile, parity with the server-side cage
// defined in flowtex/server/compiler.js.
//
// Key invariants (re-stated explicitly so a future refactor doesn't
// silently relax them):
//
//   - --no-shell-escape on every engine. Always. No per-project override.
//   - LuaLaTeX gets an additional -e '$lualatex = q(lualatex --safer %O %S)'
//     so \directlua{} can't escape to the filesystem via os.remove etc.
//   - openin_any=p + openout_any=p in the latexmk env. Restricts TeX
//     file I/O to the per-job temp dir.
//   - Each compile runs in its own temp dir, deleted on completion (or
//     cancel, or panic) via a defer.
//   - The temp dir lives under os.TempDir() and is owned 0700 by the
//     current user. Source content is written with 0600.
//
// Streaming output (SSE) is a v0.2 feature — for now, /compile blocks
// until the compile finishes and returns log + PDF as a multipart
// response. The client just shows a spinner while it waits; UX matches
// the existing "non-streaming" /api/compile/:id route on the server.

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type compileFile struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	IsBinary bool   `json:"isBinary"`
}

type compileRequest struct {
	JobID              string        `json:"jobId"`
	MainFile           string        `json:"mainFile"`
	Compiler           string        `json:"compiler"`
	ShowTrackedChanges bool          `json:"showTrackedChanges"`
	Files              []compileFile `json:"files"`
}

type compileResponse struct {
	Success bool   `json:"success"`
	Log     string `json:"log"`
	PDF     string `json:"pdf,omitempty"` // base64
	Error   string `json:"error,omitempty"`
}

const compileTimeout = 90 * time.Second

// runCompile performs a single compile end-to-end. Caller is responsible
// for sending the JSON response.
func runCompile(ctx context.Context, cfg *config, req *compileRequest) compileResponse {
	if req.MainFile == "" {
		return compileResponse{Error: "mainFile is required"}
	}
	if len(req.Files) == 0 {
		return compileResponse{Error: "no files supplied"}
	}
	if !isSafeRelPath(req.MainFile) || !strings.HasSuffix(req.MainFile, ".tex") {
		return compileResponse{Error: "invalid mainFile path"}
	}
	if req.Compiler == "" {
		req.Compiler = "pdflatex"
	}
	tex := detectTex()
	if err := validateEngineAvailable(tex, req.Compiler); err != nil {
		return compileResponse{Error: err.Error()}
	}
	if tex.Latexmk == "" {
		return compileResponse{Error: "latexmk not found on PATH; install TeX Live"}
	}

	// Per-job temp dir, mode 0700, deleted on return.
	jobDir, err := os.MkdirTemp("", "flowtex-helper-"+req.JobID+"-")
	if err != nil {
		return compileResponse{Error: fmt.Sprintf("mkdtemp: %v", err)}
	}
	defer os.RemoveAll(jobDir)
	if err := os.Chmod(jobDir, 0o700); err != nil {
		return compileResponse{Error: fmt.Sprintf("chmod jobdir: %v", err)}
	}

	// Write all files. Reject paths that try to escape the job dir.
	for _, f := range req.Files {
		if !isSafeRelPath(f.Path) {
			return compileResponse{Error: fmt.Sprintf("unsafe file path: %q", f.Path)}
		}
		dest := filepath.Join(jobDir, f.Path)
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return compileResponse{Error: fmt.Sprintf("mkdir for %s: %v", f.Path, err)}
		}
		var data []byte
		if f.IsBinary {
			data, err = base64.StdEncoding.DecodeString(f.Content)
			if err != nil {
				return compileResponse{Error: fmt.Sprintf("base64 decode %s: %v", f.Path, err)}
			}
		} else {
			data = []byte(f.Content)
		}
		if err := os.WriteFile(dest, data, 0o600); err != nil {
			return compileResponse{Error: fmt.Sprintf("write %s: %v", f.Path, err)}
		}
	}

	// Build latexmk command. Matches server/compiler.js exactly except
	// no prlimit — Go's exec on macOS / Linux with a context timeout
	// is the equivalent for the timeout dimension; resource caps are
	// deferred (most users on their own machines don't need them).
	args := []string{
		engineFlag(req.Compiler),
		"-synctex=1",
		"-interaction=nonstopmode",
		"-f",
		"--no-shell-escape",
		"-e", "$max_repeat=4",
	}
	if req.Compiler == "lualatex" {
		// --safer sandboxes the Lua os/io libraries so \directlua{}
		// can't os.remove etc.
		args = append(args, "-e", `$lualatex = q(lualatex --safer %O %S)`)
	}
	mainBase := strings.TrimSuffix(req.MainFile, ".tex")
	args = append(args,
		"-jobname="+mainBase,
		"-output-directory="+jobDir,
		req.MainFile,
	)

	tctx, cancel := context.WithTimeout(ctx, compileTimeout)
	defer cancel()
	cmd := exec.CommandContext(tctx, tex.Latexmk, args...)
	cmd.Dir = jobDir
	cmd.Env = append(os.Environ(),
		"openin_any=p",
		"openout_any=p",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()
	log := stdout.String() + stderr.String()
	log = stripJobDirPaths(log, jobDir)

	pdfPath := filepath.Join(jobDir, mainBase+".pdf")
	pdfData, pdfErr := os.ReadFile(pdfPath)

	// latexmk's -f flag means it may exit non-zero AND still produce a
	// PDF. We treat "PDF on disk" as success; otherwise it's a real
	// failure.
	if pdfErr == nil && len(pdfData) > 0 {
		return compileResponse{
			Success: true,
			Log:     log,
			PDF:     base64.StdEncoding.EncodeToString(pdfData),
		}
	}

	if errors.Is(tctx.Err(), context.DeadlineExceeded) {
		return compileResponse{Error: "compile timed out", Log: log}
	}
	if err != nil {
		return compileResponse{Error: err.Error(), Log: log}
	}
	return compileResponse{Error: "no PDF produced", Log: log}
}

func engineFlag(compiler string) string {
	switch compiler {
	case "xelatex":
		return "-xelatex"
	case "lualatex":
		return "-lualatex"
	default:
		return "-pdf"
	}
}

// isSafeRelPath is the helper-side mirror of server/services/projectService.js
// isValidFilePath. Rejects absolute paths, .. components, and embedded
// nulls. The helper writes every file under a temp dir we control, so
// even a malicious path can only escape if it passes this check AND
// the temp dir's parent is symlinked into a sensitive location — which
// would already be a system-level compromise.
func isSafeRelPath(p string) bool {
	if p == "" || strings.Contains(p, "\x00") {
		return false
	}
	if filepath.IsAbs(p) {
		return false
	}
	// Split on BOTH / and \ regardless of GOOS. Previously this used
	// filepath.Separator alone, which on Windows is '\'. That meant a
	// path like "../../etc/passwd" (forward slashes) had no separator
	// to split on, slipped through the ".." check, and then
	// filepath.Join would happily clean the slashes and escape the job
	// dir. Manual scan rather than strings.FieldsFunc so we still see
	// empty components (e.g. "a//b") and reject them.
	parts := strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' })
	// strings.FieldsFunc collapses consecutive separators, so re-scan
	// to catch "//" / "\\" / mixed cases that imply an empty path
	// component (and historically signalled a sloppy join).
	if strings.Contains(p, "//") || strings.Contains(p, "\\\\") || strings.Contains(p, "/\\") || strings.Contains(p, "\\/") {
		return false
	}
	for _, part := range parts {
		if part == "" || part == ".." || part == "." {
			return false
		}
	}
	if len(p) > 500 {
		return false
	}
	return true
}

// stripJobDirPaths replaces every absolute path that contains the job
// dir with a short placeholder. Matches server-side stripPaths so the
// log feels familiar to the user; also keeps users' machine paths out
// of compile output that might end up in a screenshot / shared review.
func stripJobDirPaths(s, jobDir string) string {
	if jobDir == "" {
		return s
	}
	return strings.ReplaceAll(s, jobDir+string(filepath.Separator), "")
}
