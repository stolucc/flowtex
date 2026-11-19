// Parser tests for the same-user peer check. The platform lookups read
// live kernel / lsof state (covered by peer_<os>_test.go); these pin
// the pure parsing against canned output so they run everywhere.

package main

import "testing"

const procNetTCPSample = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2694 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 31337 1 0000000000000000 100 0 0 10 0
   1: 0100007F:C8B2 0100007F:2694 01 00000000:00000000 00:00000000 00000000  1000        0 31338 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:C8B3 0100007F:2694 06 00000000:00000000 00:00000000 00000000     0        0 0 3 0000000000000000
   3: 0100007F:C8B4 0100007F:2694 01 00000000:00000000 00:00000000 00000000  1001        0 31339 1 0000000000000000 20 4 30 10 -1
   4: 0100007F:2694 0100007F:C8B2 01 00000000:00000000 00:00000000 00000000  1000        0 31340 1 0000000000000000 20 4 30 10 -1
`

func TestFindPeerUIDInProcNet_MatchesEstablishedClientSocket(t *testing.T) {
	// 0xC8B2 = 51378 is the browser's port, 0x2694 = 9876 the helper's.
	uid, found := findPeerUIDInProcNet(procNetTCPSample, 51378, 9876)
	if !found {
		t.Fatal("expected to find the established client socket")
	}
	if uid != 1000 {
		t.Fatalf("uid = %d, want 1000", uid)
	}
}

func TestFindPeerUIDInProcNet_ReportsOtherUsersUID(t *testing.T) {
	// 0xC8B4 belongs to uid 1001 — the parser must surface that, not
	// hide it, so the caller can refuse.
	uid, found := findPeerUIDInProcNet(procNetTCPSample, 51380, 9876)
	if !found || uid != 1001 {
		t.Fatalf("got (uid=%d, found=%v), want (1001, true)", uid, found)
	}
}

func TestFindPeerUIDInProcNet_IgnoresNonEstablishedRows(t *testing.T) {
	// 0xC8B3 is in TIME_WAIT (06): a stale row must not vouch for a
	// live connection.
	if _, found := findPeerUIDInProcNet(procNetTCPSample, 51379, 9876); found {
		t.Fatal("TIME_WAIT row must not match")
	}
}

func TestFindPeerUIDInProcNet_ServerSideRowDoesNotVouchForClient(t *testing.T) {
	// The helper's own accepted socket (local 9876, remote C8B2) is
	// owned by the helper's UID. With only that row present, the
	// client query (local C8B2, remote 9876) must not match, otherwise
	// the helper would vouch for every connection it accepted.
	serverOnly := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   4: 0100007F:2694 0100007F:C8B2 01 00000000:00000000 00:00000000 00000000  1000        0 31340 1 0000000000000000 20 4 30 10 -1
`
	if _, found := findPeerUIDInProcNet(serverOnly, 51378, 9876); found {
		t.Fatal("server-side row must not be mistaken for the client socket")
	}
}

func TestFindPeerUIDInProcNet_EmptyAndGarbage(t *testing.T) {
	if _, found := findPeerUIDInProcNet("", 1, 2); found {
		t.Fatal("empty table matched")
	}
	if _, found := findPeerUIDInProcNet("not a table\nat all\n", 1, 2); found {
		t.Fatal("garbage matched")
	}
}

func TestHexPortOf(t *testing.T) {
	cases := map[string]int{
		"0100007F:2694":                         9876,
		"00000000000000000000000001000000:C8B2": 51378,
		"0100007F":                              -1,
		"0100007F:zz":                           -1,
	}
	for in, want := range cases {
		if got := hexPortOf(in); got != want {
			t.Errorf("hexPortOf(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestClientPortOf(t *testing.T) {
	for _, in := range []string{"127.0.0.1:51378", "[::1]:51378"} {
		port, err := clientPortOf(in)
		if err != nil || port != 51378 {
			t.Errorf("clientPortOf(%q) = (%d, %v)", in, port, err)
		}
	}
	for _, bad := range []string{"", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:70000", "127.0.0.1:abc"} {
		if _, err := clientPortOf(bad); err == nil {
			t.Errorf("clientPortOf(%q) should fail", bad)
		}
	}
}

func TestLsofShowsConnection(t *testing.T) {
	out := "p4242\nf31\nn127.0.0.1:51378->127.0.0.1:9876\nf32\nn127.0.0.1:51379->127.0.0.1:443\n"
	if !lsofShowsConnection(out, 51378, 9876) {
		t.Fatal("expected a match for 51378->9876")
	}
	if lsofShowsConnection(out, 51379, 9876) {
		t.Fatal("51379 goes to :443, must not match")
	}
	if lsofShowsConnection(out, 9876, 51378) {
		t.Fatal("reversed direction must not match")
	}
	if lsofShowsConnection("", 51378, 9876) {
		t.Fatal("empty output matched")
	}
	// Port suffix must be exact: 1378 is not 51378.
	if lsofShowsConnection("n127.0.0.1:1378->127.0.0.1:9876\n", 51378, 9876) {
		t.Fatal("partial port matched")
	}
}
