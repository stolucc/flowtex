# flowtex-helper build targets.
#
# Default build is the host arch. Cross-compile targets cover mac arm64,
# mac intel, and linux x86_64 — the three platforms Phase 1 ships for.
# Windows deferred per the design doc.

BINARY := flowtex-helper
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.1.0-dev)
LDFLAGS := -s -w -X main.helperVersion=$(VERSION)

# Reproducible builds: trim local paths from the binary, strip debug
# symbols, no DWARF.
GOFLAGS := -trimpath -ldflags "$(LDFLAGS)"

.PHONY: all build run test clean dist
.PHONY: dist-mac-arm64 dist-mac-amd64 dist-linux-amd64

all: build

build:
	go build $(GOFLAGS) -o $(BINARY) .

run: build
	./$(BINARY)

test:
	go test ./...

clean:
	rm -f $(BINARY)
	rm -rf dist

dist: dist-mac-arm64 dist-mac-amd64 dist-linux-amd64

dist-mac-arm64:
	@mkdir -p dist
	GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -o dist/$(BINARY)-darwin-arm64 .

dist-mac-amd64:
	@mkdir -p dist
	GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -o dist/$(BINARY)-darwin-amd64 .

dist-linux-amd64:
	@mkdir -p dist
	GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -o dist/$(BINARY)-linux-amd64 .
