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
.PHONY: app-mac-arm64 app-mac-amd64 dmg-mac-arm64 dmg-mac-amd64

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

# ── macOS .app bundle + .dmg ────────────────────────────────────────────
# The .app bundle uses LSUIElement=true so the helper appears in the
# menu bar only, not the Dock — same UX as Things, Tot, etc. We embed
# the Mach-O executable and a minimal Info.plist; no icon for v1.

APP_NAME := FlowTex Helper

app-mac-arm64: dist-mac-arm64
	./scripts/build-app.sh dist/$(BINARY)-darwin-arm64 "dist/$(APP_NAME).app" arm64

app-mac-amd64: dist-mac-amd64
	./scripts/build-app.sh dist/$(BINARY)-darwin-amd64 "dist/$(APP_NAME).app" amd64

dmg-mac-arm64: app-mac-arm64
	hdiutil create -volname "$(APP_NAME)" -srcfolder "dist/$(APP_NAME).app" \
	  -ov -format UDZO "dist/$(APP_NAME)-arm64.dmg"

dmg-mac-amd64: app-mac-amd64
	hdiutil create -volname "$(APP_NAME)" -srcfolder "dist/$(APP_NAME).app" \
	  -ov -format UDZO "dist/$(APP_NAME)-amd64.dmg"
