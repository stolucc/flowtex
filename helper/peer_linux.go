//go:build linux

package main

import (
	"fmt"
	"os"
)

// peerCheckSupported reports whether codeless pairing can verify the
// connecting user on this OS.
const peerCheckSupported = true

// peerIsSameUser answers "does the TCP connection from remoteAddr to
// our serverPort belong to the user running the helper?" by reading
// the kernel's socket tables. No root, no cgo: /proc/net/tcp lists
// every socket on the host with its owner UID.
func peerIsSameUser(remoteAddr string, serverPort int) (bool, error) {
	clientPort, err := clientPortOf(remoteAddr)
	if err != nil {
		return false, err
	}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if uid, found := findPeerUIDInProcNet(string(data), clientPort, serverPort); found {
			return uid == os.Getuid(), nil
		}
	}
	return false, fmt.Errorf("connection %s -> :%d not found in /proc/net/tcp", remoteAddr, serverPort)
}
