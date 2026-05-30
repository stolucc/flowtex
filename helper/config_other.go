//go:build !windows

// Non-Windows stubs for the Windows-specific config-path hardening
// in config_windows.go. On Unix the existing os.Chmod(0600) on the
// file + os.MkdirAll(0700) on the dir do the right thing at the
// inode level, so these are no-ops.
//
// Kept as exported functions (not inlined #ifdef-style) so the
// call sites in config.go don't need build tags themselves — the
// linker picks the right implementation per GOOS.

package main

func secureFileACL(_ string) error { return nil }
func secureDirACL(_ string) error  { return nil }
func warnIfRoamingProfile(_ string) bool { return false }
