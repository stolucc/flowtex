# flowtex-helper build targets.
#
# Default build is the host arch. Cross-compile targets cover mac arm64,
# mac intel, linux x86_64, linux arm64 and windows x86_64 — the same
# set .github/workflows/helper-release.yml publishes.

BINARY := flowtex-helper
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.1.0-dev)
BUILD_SHA := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
BUILD_TIME := $(shell date -u +%FT%TZ)
LDFLAGS := -s -w -X main.helperVersion=$(VERSION) -X main.helperBuildSHA=$(BUILD_SHA) -X main.helperBuildTime=$(BUILD_TIME)

# Reproducible builds: trim local paths from the binary, strip debug
# symbols, no DWARF.
GOFLAGS := -trimpath -ldflags "$(LDFLAGS)"

# Oldest macOS the helper supports. The darwin targets need CGO (tray
# UI via Cocoa) and clang would otherwise default the deployment
# target to the BUILD host's OS version. Keep in sync with
# MACOS_MIN_VERSION in .github/workflows/helper-release.yml.
MACOS_MIN_VERSION := 13.0
MAC_ENV := CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=$(MACOS_MIN_VERSION) \
  CGO_CFLAGS=-mmacosx-version-min=$(MACOS_MIN_VERSION) \
  CGO_LDFLAGS=-mmacosx-version-min=$(MACOS_MIN_VERSION)

.PHONY: all build run test clean dist
.PHONY: dist-mac-arm64 dist-mac-amd64 dist-linux-amd64 dist-linux-arm64
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

dist: dist-mac-arm64 dist-mac-amd64 dist-linux-amd64 dist-linux-arm64 dist-windows-amd64

dist-mac-arm64:
	@mkdir -p dist
	$(MAC_ENV) GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -o dist/$(BINARY)-darwin-arm64 .

dist-mac-amd64:
	@mkdir -p dist
	$(MAC_ENV) GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -o dist/$(BINARY)-darwin-amd64 .

dist-linux-amd64:
	@mkdir -p dist
	GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -o dist/$(BINARY)-linux-amd64 .

# Linux is headless (tray excluded by build tags) and CGO-free, so the
# arm64 build is a plain cross-compile from any host.
dist-linux-arm64:
	@mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(GOFLAGS) -o dist/$(BINARY)-linux-arm64 .

# Windows: -H=windowsgui suppresses the console window that would
# otherwise pop up when the user double-clicks the .exe (tray apps
# have no need for a foreground console). The flag is layered ON TOP
# of the existing LDFLAGS so VCS metadata still injects.
dist-windows-amd64:
	@mkdir -p dist
	GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS) -H=windowsgui" -o dist/$(BINARY)-windows-amd64.exe .

# ── macOS .app bundle + .dmg ────────────────────────────────────────────
# The .app bundle uses LSUIElement=true so the helper appears in the
# menu bar only, not the Dock — same UX as Things, Tot, etc. We embed
# the Mach-O executable and a minimal Info.plist; no icon for v1.

APP_NAME := FlowTex Helper

app-mac-arm64: dist-mac-arm64
	./scripts/build-app.sh dist/$(BINARY)-darwin-arm64 "dist/$(APP_NAME).app" arm64 "$(VERSION)" "$(MACOS_MIN_VERSION)"

app-mac-amd64: dist-mac-amd64
	./scripts/build-app.sh dist/$(BINARY)-darwin-amd64 "dist/$(APP_NAME).app" amd64 "$(VERSION)" "$(MACOS_MIN_VERSION)"

dmg-mac-arm64: app-mac-arm64
	hdiutil create -volname "$(APP_NAME)" -srcfolder "dist/$(APP_NAME).app" \
	  -ov -format UDZO "dist/$(APP_NAME)-arm64.dmg"

dmg-mac-amd64: app-mac-amd64
	hdiutil create -volname "$(APP_NAME)" -srcfolder "dist/$(APP_NAME).app" \
	  -ov -format UDZO "dist/$(APP_NAME)-amd64.dmg"
