// Pairing flow (LOCAL_COMPILE_DESIGN.md §7.3).
//
// The bearer token is 256 bits — fine for steady-state auth, hostile to
// copy-paste UX. So we don't ask the user to type it. Instead:
//
//   1. User runs `flowtex-helper pair` in a terminal. The CLI prints a
//      6-digit code and writes the code + an expiry to a shared file on
//      disk (~/.flowtex-helper/pairing.lock) that the running helper
//      process polls.
//   2. The running helper notices the file and opens a 60-second window
//      during which POST /pair?code=NNNNNN will mint a fresh bearer
//      token, write it back into the config, and return it to the
//      browser. After 60s the window closes; the file is removed.
//   3. The browser stores the bearer token in localStorage.
//
// Why not have the running helper print the code itself? Because the
// helper is normally backgrounded — Mac users will start it via a
// LaunchAgent, Linux via systemd-user. They don't have a foreground
// stdout to print to. The separate `pair` subcommand is what the user
// invokes when they want to register a new browser, regardless of how
// the helper is running.
//
// Brute-force defence: 6 digits = 10^6 codes. Window is 60s. The helper
// has no per-IP rate limit (loopback) so an attacker tab can hammer
// /pair as fast as the OS will let it — easily >10k attempts/s. To stop
// that the pairStore counts wrong attempts inside an active window and
// slams the window shut after `maxPairAttempts` failures. The pairing
// terminal command can re-open a fresh window if a legit user hit the
// limit by typo, so the user-visible cost is a re-run of
// `flowtex-helper pair`.

package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const pairLockFileName = "pairing.lock"
const pairingWindowSeconds = 60

// maxPairAttempts caps wrong-code submissions during one window. Five
// is enough that a fumbling user can correct a typo or two without
// re-running `pair`, but small enough that 1 in 200,000 odds on a
// random guess fall to effectively zero (5 * 1/10^6).
const maxPairAttempts = 5

type pairingState struct {
	Code    string `json:"code"`
	Expires int64  `json:"expires_unix"`
}

func pairLockPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, pairLockFileName), nil
}

// startPairingWindow is invoked from the `pair` subcommand. Writes a
// fresh code + expiry to the lock file and returns the code so the CLI
// can print it.
func startPairingWindow(_ *config) string {
	code := generatePairCode()
	state := pairingState{
		Code:    code,
		Expires: time.Now().Add(pairingWindowSeconds * time.Second).Unix(),
	}
	data, _ := json.Marshal(state)
	path, err := pairLockPath()
	if err != nil {
		// Fall through — the running helper will just never see a code,
		// but we still want to show one to the user.
		return code
	}
	_ = os.WriteFile(path, data, 0o600)
	return code
}

// pairStore holds the running helpers view of the current pairing
// window. The running server polls the lock file every second; on
// detection it loads state into the store. /pair handler consults the
// store.
type pairStore struct {
	mu       sync.Mutex
	code     string
	until    time.Time
	attempts int // count of wrong-code submissions inside the current window
}

func newPairStore() *pairStore { return &pairStore{} }

// loadFromFile reads the lock file if present and updates the store.
// Idempotent — caller invokes from a 1Hz ticker.
func (p *pairStore) loadFromFile() {
	path, err := pairLockPath()
	if err != nil {
		return
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		return
	}
	var st pairingState
	if err := json.Unmarshal(data, &st); err != nil {
		_ = os.Remove(path)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	// Reset attempts whenever we load a (new) window. Without this a
	// previous window's failures would carry into a fresh `pair` and
	// instantly slam the new window shut.
	if p.code != st.Code {
		p.attempts = 0
	}
	p.code = st.Code
	p.until = time.Unix(st.Expires, 0)
}

// consume returns (true) if `code` matches the active window. After
// `maxPairAttempts` wrong submissions inside the same window we close
// the window entirely — the user has to re-run `flowtex-helper pair`.
// Successful consume also closes the window so the code can't be reused.
func (p *pairStore) consume(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.code == "" || time.Now().After(p.until) {
		// No active window. Whatever code the client sent, reject.
		return false
	}
	// Constant-time compare. The window is loopback-only and codes are
	// short, so the practical timing attack surface is tiny, but match
	// the bearer-token path's discipline.
	ok := subtle.ConstantTimeCompare([]byte(p.code), []byte(code)) == 1
	if ok {
		// Single-use: clear the window AND the lock file so we don't
		// honour the same code twice.
		p.code = ""
		p.until = time.Time{}
		p.attempts = 0
		if path, err := pairLockPath(); err == nil {
			_ = os.Remove(path)
		}
		return true
	}
	// Wrong code. Bump the attempt counter and, if we've hit the
	// brute-force cap, slam the window shut so the attacker can't keep
	// hammering. The user can re-open with another `flowtex-helper pair`.
	p.attempts++
	if p.attempts >= maxPairAttempts {
		p.code = ""
		p.until = time.Time{}
		p.attempts = 0
		if path, err := pairLockPath(); err == nil {
			_ = os.Remove(path)
		}
	}
	return false
}

// generatePairCode produces a 6-digit code (zero-padded) drawn from
// crypto/rand. Avoid math/rand — pairing brute-force defence needs an
// unguessable code, not just statistically uniform.
func generatePairCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		// Same posture as token generation — if the OS RNG is broken
		// we refuse to play.
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return fmt.Sprintf("%06d", n.Int64())
}
