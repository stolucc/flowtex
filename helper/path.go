// PATH augmentation at process startup.
//
// When the helper is launched as a macOS .app via Launch Services (or
// at login by a LaunchAgent), it inherits launchd's bare PATH:
//
//   /usr/bin:/bin:/usr/sbin:/sbin
//
// That does NOT include the standard TeX Live locations like
// /Library/TeX/texbin (the MacTeX symlink farm) or
// /usr/local/texlive/YYYY/bin/*. So exec.LookPath("tex") returns
// ENOENT, the year detection in tex.go fails silently, and the
// FlowTex badge shows "TeX Live ?" — the symptom that prompted this
// file.
//
// Fix: at startup, glob the known locations and prepend whatever
// exists to $PATH. The user's interactive-shell PATH is not available
// to a GUI app, so we can't borrow theirs — we have to know the
// likely places ourselves. The list below mirrors what
// server/compiler.js does on the FlowTex VPS.

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// augmentPathForTeX prepends standard TeX + Homebrew locations to
// $PATH so the helper finds latexmk / pdflatex / tex / biber whether
// it was launched from a terminal or from a Launch Agent / .app.
// Idempotent: paths already on $PATH stay put rather than duplicating.
func augmentPathForTeX() {
	candidates := texLikeDirs()
	existing := os.Getenv("PATH")
	have := map[string]bool{}
	for _, p := range filepath.SplitList(existing) {
		have[p] = true
	}

	var prepend []string
	for _, p := range candidates {
		if have[p] {
			continue
		}
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			prepend = append(prepend, p)
		}
	}

	if len(prepend) == 0 {
		return
	}
	newPath := strings.Join(prepend, string(os.PathListSeparator))
	if existing != "" {
		newPath = newPath + string(os.PathListSeparator) + existing
	}
	_ = os.Setenv("PATH", newPath)
}

// texLikeDirs returns the candidate directories worth probing for
// each OS. Includes Homebrew (where users often install latexmk
// auxiliaries) and every per-year /usr/local/texlive/YYYY/bin/* we
// can discover by globbing — so this stays correct as users add or
// remove TeX Live releases via install-texlive-year.sh.
func texLikeDirs() []string {
	var dirs []string

	switch runtime.GOOS {
	case "darwin":
		dirs = append(dirs,
			"/Library/TeX/texbin",
			"/opt/homebrew/bin",
			"/usr/local/bin",
		)
	case "linux":
		dirs = append(dirs,
			"/usr/local/bin",
			"/usr/bin",
		)
	}

	// /usr/local/texlive/<year>/bin/<arch> — same shape across macOS
	// and Linux. Glob for whichever years are present, then pick the
	// bin/<arch> subdir that exists for our host.
	matches, _ := filepath.Glob("/usr/local/texlive/*/bin/*")
	dirs = append(dirs, matches...)

	return dirs
}
