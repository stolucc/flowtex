// TeX Live detection: report which year + scheme + engines + biber are
// installed on this machine. Used to populate /version, which the
// browser compares against the project's tex_distribution pin.

package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type texInfo struct {
	Engine                  string             `json:"engine"`                   // always "TeX Live" if detected
	Year                    string             `json:"year"`                     // e.g. "2025" — default-on-PATH version
	Scheme                  string             `json:"scheme"`                   // e.g. "full" — best-effort
	EnginesAvailable        []string           `json:"engines_available"`        // {pdflatex,xelatex,lualatex} found on PATH
	Biber                   string             `json:"biber"`                    // e.g. "2.20"
	Latexmk                 string             `json:"latexmk"`                  // path to latexmk
	DistributionsAvailable  []texDistribution  `json:"distributions_available"`  // every /usr/local/texlive/YYYY we can find
}

// texDistribution describes one of possibly several side-by-side
// TeX Live installs. The client offers these as picker options when
// compiling locally so a project pinned to 2024 still compiles with
// 2024 even if 2026 is the default on $PATH.
type texDistribution struct {
	Year string `json:"year"` // "2024"
	Path string `json:"path"` // "/usr/local/texlive/2024/bin/universal-darwin"
}

var (
	texVersionRE = regexp.MustCompile(`TeX Live (\d{4})`)
	biberRE      = regexp.MustCompile(`Biber version: (\S+)`)
	// Any string that's claimed to be a TeX Live "year" — config values,
	// /usr/local/texlive/<dir> names, browser-supplied texDistribution
	// fields — passes through this before being used as a filesystem
	// path component. Rejects "..", "abcd", "20.5", etc. Keeps the
	// path-traversal defence local to one regex so all callers agree.
	yearRE = regexp.MustCompile(`^\d{4}$`)
)

// isValidTexYear is the single source of truth for whether a string
// is safe to treat as a TeX Live release year. Used by config loading,
// distribution detection, and per-compile pinning so a malformed value
// can't slip into a filepath.Join / Glob call.
func isValidTexYear(s string) bool { return yearRE.MatchString(s) }

func detectTex() texInfo {
	out := texInfo{}
	if path, err := exec.LookPath("latexmk"); err == nil {
		out.Latexmk = path
	}
	// Year + engine: `tex --version` outputs the TeX Live year for any
	// distribution that ships it. Falls back to pdftex --version on rare
	// installs.
	year := parseYearFromCmd("tex", "--version")
	if year == "" {
		year = parseYearFromCmd("pdftex", "--version")
	}
	if year != "" {
		out.Engine = "TeX Live"
		out.Year = year
	}
	// Engines available — just LookPath for each. Don't run them.
	for _, eng := range []string{"pdflatex", "xelatex", "lualatex"} {
		if _, err := exec.LookPath(eng); err == nil {
			out.EnginesAvailable = append(out.EnginesAvailable, eng)
		}
	}
	// Biber version. Optional — some installs ship only bibtex.
	if biberBin, err := exec.LookPath("biber"); err == nil {
		cmd := exec.Command(biberBin, "--version")
		var buf bytes.Buffer
		cmd.Stdout = &buf
		cmd.Stderr = &buf
		_ = cmd.Run()
		if m := biberRE.FindStringSubmatch(buf.String()); len(m) >= 2 {
			out.Biber = m[1]
		}
	}
	// Scheme: best-effort. The texlive.config file or `tlmgr info`
	// would tell us, but tlmgr can be slow / require sudo. Skip for
	// now — leave as empty string; the client only uses Year for the
	// match check.
	out.DistributionsAvailable = detectAllDistributions()
	return out
}

// detectAllDistributions scans /usr/local/texlive/<year>/bin/<arch>/
// for every installed annual release. Mirrors the server-side
// detector in server/compiler.js so the FlowTex picker UI presents
// a coherent superset across server + helper. Sorted newest-first.
func detectAllDistributions() []texDistribution {
	var out []texDistribution
	base := "/usr/local/texlive"
	entries, err := os.ReadDir(base)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		year := e.Name()
		// 4-digit year only; skip "texmf-local" and friends. Also
		// rejects 4-char non-digit names (e.g. "abcd") so a hand-
		// crafted directory can't appear as a tray option.
		if !isValidTexYear(year) {
			continue
		}
		matches, _ := filepath.Glob(filepath.Join(base, year, "bin", "*"))
		for _, m := range matches {
			if _, err := os.Stat(filepath.Join(m, "pdflatex")); err == nil {
				out = append(out, texDistribution{Year: year, Path: m})
				break // one arch per year is enough
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Year > out[j].Year })
	return out
}

func parseYearFromCmd(name string, args ...string) string {
	bin, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	cmd := exec.Command(bin, args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	_ = cmd.Run()
	if m := texVersionRE.FindStringSubmatch(buf.String()); len(m) >= 2 {
		return m[1]
	}
	return ""
}

// FormatError returns an error message including which engines are
// missing if the requested compiler can't be found. Helps the user
// understand why a compile failed before a single byte was sent to
// latexmk.
func validateEngineAvailable(info texInfo, engine string) error {
	for _, e := range info.EnginesAvailable {
		if e == engine {
			return nil
		}
	}
	return fmt.Errorf("requested engine %q is not installed (available: %s)",
		engine, strings.Join(info.EnginesAvailable, ", "))
}
