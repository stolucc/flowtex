// Tests for the compile rate limiter + concurrency semaphore introduced
// by the M2 fix in the helper security audit. The defence is two-layer:
// a token bucket caps burst rate, a buffered channel caps simultaneous
// in-flight compiles. Both must admit a request for it to run.

package main

import (
	"context"
	"testing"
	"time"
)

func TestCompileLimiter_AdmitsUpToBurst(t *testing.T) {
	l := newCompileLimiter(2, 3, 60) // 3-burst, 60/min
	for i := 0; i < 3; i++ {
		if _, ok := l.allow(); !ok {
			t.Fatalf("burst slot %d: expected admit", i)
		}
	}
	// 4th must be rejected — bucket is empty.
	if _, ok := l.allow(); ok {
		t.Fatal("4th request inside burst: expected reject")
	}
}

func TestCompileLimiter_RejectsBeforeRefill(t *testing.T) {
	l := newCompileLimiter(2, 1, 60) // 1-burst
	if _, ok := l.allow(); !ok {
		t.Fatal("first request should be admitted")
	}
	wait, ok := l.allow()
	if ok {
		t.Fatal("second immediate request should be rejected")
	}
	// Should be ~1s until refill at 60/min.
	if wait <= 0 || wait > 2*time.Second {
		t.Fatalf("expected wait ~1s, got %v", wait)
	}
}

func TestCompileLimiter_RefillsOverTime(t *testing.T) {
	l := newCompileLimiter(2, 1, 600) // very fast refill: 10/sec
	if _, ok := l.allow(); !ok {
		t.Fatal("first request should be admitted")
	}
	if _, ok := l.allow(); ok {
		t.Fatal("immediate second request should be rejected")
	}
	time.Sleep(150 * time.Millisecond) // ~1.5 tokens worth at 10/s
	if _, ok := l.allow(); !ok {
		t.Fatal("after refill window, request should be admitted")
	}
}

func TestCompileLimiter_SlotsBlockBeyondCap(t *testing.T) {
	l := newCompileLimiter(2, 100, 6000) // generous rate, narrow slots
	ctx := context.Background()
	// Split into separate asserts so the linter doesn't flag the two
	// calls as identical (staticcheck SA4000). Each call mutates the
	// limiter — that's the whole point — but syntactically the two
	// `!l.acquireSlot(ctx)` looked redundant.
	if !l.acquireSlot(ctx) {
		t.Fatal("first slot acquisition should succeed")
	}
	if !l.acquireSlot(ctx) {
		t.Fatal("second slot acquisition should succeed")
	}
	// Third slot must block — try with a short timeout.
	tctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if l.acquireSlot(tctx) {
		t.Fatal("third slot acquisition should have timed out")
	}
	// Release one — third acquisition should now succeed.
	l.releaseSlot()
	if !l.acquireSlot(ctx) {
		t.Fatal("after release, slot acquisition should succeed")
	}
}
