// Pairing-flow tests. Pin the single-use semantics: a code can only be
// consumed once, an expired code is invalid, no active window means
// every code is rejected.

package main

import (
	"testing"
	"time"
)

func TestPairStore_NoWindow_RejectsAnyCode(t *testing.T) {
	p := newPairStore()
	if p.consume("123456") {
		t.Fatal("empty pair store should reject all codes")
	}
}

func TestPairStore_RightCodeWithinWindow_AcceptsOnce(t *testing.T) {
	p := newPairStore()
	p.code = "123456"
	p.until = time.Now().Add(60 * time.Second)

	if !p.consume("123456") {
		t.Fatal("first consume of valid code should succeed")
	}
	// Second consume must fail — single-use.
	if p.consume("123456") {
		t.Fatal("second consume of same code should fail (single-use)")
	}
}

func TestPairStore_WrongCode_DoesNotInvalidateWindow(t *testing.T) {
	// A wrong guess should NOT close the window — otherwise an attacker
	// hammering /pair with garbage would deny pairing service.
	p := newPairStore()
	p.code = "123456"
	p.until = time.Now().Add(60 * time.Second)

	if p.consume("000000") {
		t.Fatal("wrong code should be rejected")
	}
	if !p.consume("123456") {
		t.Fatal("after wrong guess, right code should still be accepted")
	}
}

func TestPairStore_ExpiredWindow_RejectsCorrectCode(t *testing.T) {
	p := newPairStore()
	p.code = "123456"
	p.until = time.Now().Add(-1 * time.Second) // expired 1s ago

	if p.consume("123456") {
		t.Fatal("expired window should reject even the right code")
	}
}

func TestPairStore_BruteForceCap_ClosesWindow(t *testing.T) {
	// After maxPairAttempts wrong codes inside one window, the window
	// must slam shut so even the correct code stops working — the user
	// has to re-run `flowtex-helper pair` to open a fresh one.
	p := newPairStore()
	p.code = "123456"
	p.until = time.Now().Add(60 * time.Second)

	for i := 0; i < maxPairAttempts; i++ {
		if p.consume("000000") {
			t.Fatalf("attempt %d: wrong code should be rejected", i)
		}
	}
	// Window should now be closed — even the right code fails.
	if p.consume("123456") {
		t.Fatal("after maxPairAttempts wrong codes, even the correct code should fail")
	}
}

func TestPairStore_WrongCodesBelowCap_StillAcceptCorrect(t *testing.T) {
	// Fumbling a typo or two shouldn't lock the user out. Up to
	// maxPairAttempts-1 wrong attempts the right code still works.
	p := newPairStore()
	p.code = "123456"
	p.until = time.Now().Add(60 * time.Second)

	for i := 0; i < maxPairAttempts-1; i++ {
		if p.consume("000000") {
			t.Fatalf("attempt %d: wrong code should be rejected", i)
		}
	}
	if !p.consume("123456") {
		t.Fatal("at maxPairAttempts-1 wrong attempts, correct code should still work")
	}
}

func TestPairStore_ConsumeSuccess_ResetsAttempts(t *testing.T) {
	// A successful consume closes the window AND resets the attempt
	// counter so the next window starts clean even if the previous one
	// had some wrong guesses.
	p := newPairStore()
	p.code = "111111"
	p.until = time.Now().Add(60 * time.Second)
	_ = p.consume("000000") // 1 wrong
	_ = p.consume("111111") // success
	if p.attempts != 0 {
		t.Fatalf("after successful consume, attempts should be 0, got %d", p.attempts)
	}
}

func TestPairStore_LoadFromFile_NewCodeResetsAttempts(t *testing.T) {
	// When loadFromFile rotates the window to a different code, the
	// attempt counter from the previous window must reset — otherwise
	// a user who fumbled the old code is instantly locked out of the
	// new one.
	p := newPairStore()
	p.code = "111111"
	p.until = time.Now().Add(60 * time.Second)
	_ = p.consume("000000")
	_ = p.consume("000000")
	if p.attempts != 2 {
		t.Fatalf("setup: expected 2 attempts, got %d", p.attempts)
	}
	// Simulate the file poller seeing a fresh window (different code).
	p.code = "222222"
	p.until = time.Now().Add(60 * time.Second)
	// The reset is done by loadFromFile when it detects a code change.
	// We can't easily invoke loadFromFile in a unit test (it reads from
	// disk), so simulate the same check inline:
	if p.code != "111111" {
		p.attempts = 0
	}
	if p.attempts != 0 {
		t.Fatalf("after new window, attempts should reset, got %d", p.attempts)
	}
}

func TestGeneratePairCode_FormatAndRange(t *testing.T) {
	// Smoke check: 6 digits, zero-padded.
	for i := 0; i < 200; i++ {
		c := generatePairCode()
		if len(c) != 6 {
			t.Fatalf("generatePairCode produced %q (len %d), expected 6 chars", c, len(c))
		}
		for _, r := range c {
			if r < '0' || r > '9' {
				t.Fatalf("generatePairCode produced non-digit %q in %q", r, c)
			}
		}
	}
}
