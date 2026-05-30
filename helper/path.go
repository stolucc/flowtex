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
//
// If preferYear is non-empty AND /usr/local/texlive/<year>/bin/* exists,
// that year's bin dir is placed at the *front* of the prepended block
// so it wins on lookup over any other installed year. Use this to
// implement the tray's "Default TeX Live" picker.
func augmentPathForTeX(preferYear string) {
	candidates := texLikeDirs()
	// Hoist the preferred year to the front so it beats any other
	// installed year that ended up in `candidates`.
	if preferYear != "" {
		matches, _ := filepath.Glob(filepath.Join("/usr/local/texlive", preferYear, "bin", "*"))
		// Filter out the preferred-year entries from the existing list
		// before prepending them — otherwise the first occurrence wins
		// but the original spot is wasted.
		hoist := map[string]bool{}
		for _, m := range matches {
			hoist[m] = true
		}
		filtered := candidates[:0]
		for _, c := range candidates {
			if !hoist[c] {
				filtered = append(filtered, c)
			}
		}
		candidates = append(matches, filtered...)
	}

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
	case "windows":
		// MiKTeX defaults to %LocalAppData%\Programs\MiKTeX\miktex\bin\x64
		// when installed for the current user, or
		// C:\Program Files\MiKTeX\miktex\bin\x64 system-wide. TeX Live
		// year installs are picked up by the glob below. Probe both
		// MiKTeX locations defensively — first match wins.
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			dirs = append(dirs, filepath.Join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"))
		}
		dirs = append(dirs,
			`C:\Program Files\MiKTeX\miktex\bin\x64`,
			`C:\Program Files (x86)\MiKTeX\miktex\bin`,
		)
	}

	// TeX Live year installs:
	//   Unix:    /usr/local/texlive/<year>/bin/<arch>/   (existing)
	//   Windows: C:\texlive\<year>\bin\windows\          (new)
	// Glob both — non-matching ones return nil and append harmlessly.
	matches, _ := filepath.Glob("/usr/local/texlive/*/bin/*")
	dirs = append(dirs, matches...)
	if runtime.GOOS == "windows" {
		winMatches, _ := filepath.Glob(`C:\texlive\*\bin\windows`)
		dirs = append(dirs, winMatches...)
	}

	return dirs
}
