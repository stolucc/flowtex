// TeX Live detection: report which year + scheme + engines + biber are
// installed on this machine. Used to populate /version, which the
// browser compares against the project's tex_distribution pin.

package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

type texInfo struct {
	Engine            string   `json:"engine"`             // always "TeX Live" if detected
	Year              string   `json:"year"`               // e.g. "2025"
	Scheme            string   `json:"scheme"`             // e.g. "full" — best-effort
	EnginesAvailable  []string `json:"engines_available"`  // {pdflatex,xelatex,lualatex} found on PATH
	Biber             string   `json:"biber"`              // e.g. "2.20"
	Latexmk           string   `json:"latexmk"`            // path to latexmk
}

var (
	texVersionRE = regexp.MustCompile(`TeX Live (\d{4})`)
	biberRE      = regexp.MustCompile(`Biber version: (\S+)`)
)

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
