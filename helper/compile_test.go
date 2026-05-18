// Tests for the compile path-safety helpers. We can't easily run a
// full latexmk in unit tests, so these focus on the contracts that
// keep the compile cage tight: path sanitization (no traversal, no
// absolute paths, no null bytes) and the engine-flag mapping.

package main

import (
	"testing"
)

func TestIsSafeRelPath(t *testing.T) {
	good := []string{
		"main.tex",
		"chapter1/intro.tex",
		"a/b/c/d.bib",
		"figures/diagram.pdf",
		"unicode_naïve.tex",
	}
	for _, p := range good {
		if !isSafeRelPath(p) {
			t.Errorf("expected %q to be SAFE, got rejected", p)
		}
	}

	bad := []string{
		"",                                     // empty
		"/etc/passwd",                          // absolute
		"../escape.tex",                        // traversal
		"a/../../etc/passwd",                   // nested traversal
		"a//b.tex",                             // double separator → empty component
		"file\x00.tex",                         // null byte
		"a/" + string(make([]byte, 500)) + ".tex", // length cap (>500)
	}
	for _, p := range bad {
		if isSafeRelPath(p) {
			t.Errorf("expected %q to be UNSAFE, got accepted", p)
		}
	}
}

func TestEngineFlag(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"pdflatex", "-pdf"},
		{"xelatex", "-xelatex"},
		{"lualatex", "-lualatex"},
		{"", "-pdf"},
		{"unknown", "-pdf"}, // fallback to pdflatex on anything we don't recognise
	}
	for _, c := range cases {
		if got := engineFlag(c.in); got != c.want {
			t.Errorf("engineFlag(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestStripJobDirPaths(t *testing.T) {
	jobDir := "/tmp/flowtex-helper-abc"
	in := "Compiling " + jobDir + "/main.tex\nOutput written to " + jobDir + "/main.pdf"
	out := stripJobDirPaths(in, jobDir)
	if want := "Compiling main.tex\nOutput written to main.pdf"; out != want {
		t.Errorf("stripJobDirPaths produced:\n%q\nwant:\n%q", out, want)
	}
}

func TestStripJobDirPaths_EmptyJobDir_Noop(t *testing.T) {
	if got := stripJobDirPaths("anything", ""); got != "anything" {
		t.Errorf("empty job dir should leave input untouched, got %q", got)
	}
}
