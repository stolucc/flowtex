//go:build !darwin && !windows

// Stub for OSes that don't have a portable tray (Linux at the moment).
// The systray library still has a no-op implementation there, but we
// never call SetIcon on this build path because runWithTray itself is
// gated to darwin+windows. Function kept defined so any future caller
// outside the tray init won't cause a compile error.

package main

func trayIconBytes() []byte { return nil }
