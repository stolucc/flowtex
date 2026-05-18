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
