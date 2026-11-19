//go:build linux || darwin

// Live check of the platform lookup: open a real loopback listener,
// connect to it from this process (same UID by construction), and ask
// peerIsSameUser about that connection. Covers the /proc/net/tcp read
// on Linux and the lsof call on macOS.

package main

import (
	"net"
	"testing"
)

func TestPeerIsSameUser_LiveLoopback(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("no loopback listener: %v", err)
	}
	defer ln.Close()
	serverPort := ln.Addr().(*net.TCPAddr).Port

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	srvConn := <-accepted
	defer srvConn.Close()

	// What the HTTP server would see as r.RemoteAddr.
	remoteAddr := srvConn.RemoteAddr().String()
	same, err := peerIsSameUser(remoteAddr, serverPort)
	if err != nil {
		t.Fatalf("peerIsSameUser(%s, %d): %v", remoteAddr, serverPort, err)
	}
	if !same {
		t.Fatalf("own connection %s -> :%d reported as a different user", remoteAddr, serverPort)
	}

	// A port nobody is connected from must not be vouched for.
	same, err = peerIsSameUser("127.0.0.1:1", serverPort)
	if same {
		t.Fatalf("unconnected port reported as same user (err=%v)", err)
	}
}
