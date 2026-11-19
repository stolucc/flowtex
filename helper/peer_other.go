//go:build !linux && !darwin

package main

const peerCheckSupported = false

// peerIsSameUser has no implementation here (Windows would need
// GetExtendedTcpTable + process token lookup). Codeless pairing is
// refused and the CLI / tray fall back to the 6-digit code.
func peerIsSameUser(_ string, _ int) (bool, error) {
	return false, errPeerCheckUnsupported
}
