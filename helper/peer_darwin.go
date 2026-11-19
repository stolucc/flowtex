//go:build darwin

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

const peerCheckSupported = true

// peerIsSameUser shells out to lsof, which ships with macOS. Run as a
// normal user, lsof can only see the calling user's own processes, and
// -a -u <uid> makes that explicit, so finding the client socket in its
// output proves the connection belongs to the helper's user. The call
// happens once per pairing attempt, never on the compile path.
func peerIsSameUser(remoteAddr string, serverPort int) (bool, error) {
	clientPort, err := clientPortOf(remoteAddr)
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "lsof",
		"-nP",
		"-a",
		"-u", strconv.Itoa(os.Getuid()),
		"-iTCP:"+strconv.Itoa(clientPort),
		"-sTCP:ESTABLISHED",
		"-F", "n",
	)
	out, err := cmd.Output()
	// lsof exits 1 when nothing matched; that is a legitimate "not
	// ours" answer, not a failure of the check itself.
	if err != nil && len(out) == 0 {
		if ctx.Err() != nil {
			return false, fmt.Errorf("lsof: %w", ctx.Err())
		}
		if _, isExit := err.(*exec.ExitError); !isExit {
			return false, fmt.Errorf("lsof: %w", err)
		}
	}
	return lsofShowsConnection(string(out), clientPort, serverPort), nil
}
