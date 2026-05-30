// Cross-platform tests for the ACL hardening helpers. The Windows
// implementations shell out to icacls.exe (covered by manual + CI
// runner verification — there's no easy way to assert NTFS DACL
// state from Go); the non-Windows stubs are pinned here to be
// no-ops so a future "this fails on Linux now" regression is loud.

package main

import (
	"runtime"
	"testing"
)

func TestSecureFileACL_NoOpOnUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows path tested manually + via CI runner; this is the non-Windows stub guard")
	}
	// On non-Windows, calling with a bogus path must STILL return nil
	// (the stub doesn't touch the FS). If a future contributor wires
	// the Windows implementation by mistake on Unix this fails.
	if err := secureFileACL("/this/path/definitely/does/not/exist/and/must/not/be/touched"); err != nil {
		t.Fatalf("secureFileACL on unix should be a no-op, got: %v", err)
	}
}

func TestSecureDirACL_NoOpOnUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows path tested manually + via CI runner; this is the non-Windows stub guard")
	}
	if err := secureDirACL("/this/path/definitely/does/not/exist"); err != nil {
		t.Fatalf("secureDirACL on unix should be a no-op, got: %v", err)
	}
}

func TestWarnIfRoamingProfile_DetectsUNC(t *testing.T) {
	if runtime.GOOS != "windows" {
		// On non-Windows the stub always returns false. Confirm.
		if warnIfRoamingProfile(`\\fileserver\share\user`) {
			t.Fatal("non-Windows stub should always return false")
		}
		return
	}
	// On Windows: UNC paths trigger the warning, local paths don't.
	cases := []struct {
		path string
		want bool
	}{
		{`\\fileserver\users$\alice\.flowtex-helper`, true},
		{`\\?\C:\Users\alice\.flowtex-helper`, true}, // \\?\ extended-length form starts with \\
		{`C:\Users\alice\.flowtex-helper`, false},
		{`D:\Profiles\alice\.flowtex-helper`, false},
	}
	for _, c := range cases {
		if got := warnIfRoamingProfile(c.path); got != c.want {
			t.Errorf("warnIfRoamingProfile(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}
