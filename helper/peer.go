// Same-user peer check for codeless pairing.
//
// The helper listens on loopback, and loopback is shared by every OS
// user and process on the machine. The 6-digit pairing code proves
// that whoever clicks "Pair" in the browser can also see the helper's
// screen or terminal, i.e. is the helper's owner. Codeless pairing
// drops the code, so it needs a different proof of the same fact: the
// TCP connection carrying the /pair request must belong to the same
// OS user that runs the helper. Anything running as that user can
// already read ~/.flowtex-helper/config.json and take the token, so
// this check gives codeless pairing the same boundary the token has.
//
// Platform lookups live in peer_<os>.go. The parsers here are pure
// functions so they can be unit-tested with canned kernel / lsof
// output on any OS.

package main

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

// errPeerCheckUnsupported is returned where no same-user lookup exists
// (Windows for now, and anything else we have not implemented). The
// CLI and the /pair handler treat it as "fall back to the code".
var errPeerCheckUnsupported = errors.New("same-user check is not supported on this OS")

// clientPortOf extracts the TCP source port from an http.Request
// RemoteAddr ("127.0.0.1:51234", "[::1]:51234").
func clientPortOf(remoteAddr string) (int, error) {
	_, portStr, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return 0, fmt.Errorf("parse remote addr %q: %w", remoteAddr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return 0, fmt.Errorf("parse remote port %q", portStr)
	}
	return port, nil
}

// findPeerUIDInProcNet scans a /proc/net/tcp or /proc/net/tcp6 table
// for the ESTABLISHED socket whose local port is clientPort and whose
// remote port is serverPort, and returns the owning UID. The kernel
// lists every user's sockets in that file, so a hit for another user
// is reported with their UID rather than hidden.
//
// Row layout (fields split on whitespace):
//
//	sl local_address rem_address st tx:rx tr:tm->when retrnsmt uid ...
//	0: 0100007F:C8B2  0100007F:2694 01 00000000:00000000 00:00000000 00000000  1000 ...
//
// Addresses are hex; the part after the colon is the port. We match on
// ports and state only: the helper binds loopback, so the 4-tuple is
// already pinned to this machine, and skipping the address decode
// keeps the parser identical for v4 and v6 tables.
func findPeerUIDInProcNet(table string, clientPort, serverPort int) (uid int, found bool) {
	const stateEstablished = "01"
	for _, line := range strings.Split(table, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 8 || fields[0] == "sl" {
			continue
		}
		if fields[3] != stateEstablished {
			continue
		}
		if hexPortOf(fields[1]) != clientPort || hexPortOf(fields[2]) != serverPort {
			continue
		}
		u, err := strconv.Atoi(fields[7])
		if err != nil {
			continue
		}
		return u, true
	}
	return 0, false
}

// hexPortOf returns the port from a "HEXADDR:HEXPORT" column, or -1.
func hexPortOf(addr string) int {
	i := strings.LastIndexByte(addr, ':')
	if i < 0 {
		return -1
	}
	p, err := strconv.ParseInt(addr[i+1:], 16, 32)
	if err != nil {
		return -1
	}
	return int(p)
}

// lsofShowsConnection reports whether `lsof -F n` output contains the
// loopback connection clientPort -> serverPort. Without root, lsof on
// macOS only lists the calling user's own processes, so a hit means
// the socket belongs to the same user as the helper.
//
// -F n output is one field per line, "n" prefix for the name column:
//
//	p1234
//	n127.0.0.1:51234->127.0.0.1:9876
func lsofShowsConnection(out string, clientPort, serverPort int) bool {
	wantLocal := fmt.Sprintf(":%d", clientPort)
	wantRemote := fmt.Sprintf(":%d", serverPort)
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "n") {
			continue
		}
		local, remote, ok := strings.Cut(line[1:], "->")
		if !ok {
			continue
		}
		if strings.HasSuffix(local, wantLocal) && strings.HasSuffix(remote, wantRemote) {
			return true
		}
	}
	return false
}
