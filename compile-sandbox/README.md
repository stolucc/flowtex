# FlowTex compile sandbox

A small Docker image FlowTex uses to compile LaTeX in a sibling
container per request. The image is the safe-by-default replacement
for the in-process `prlimit`-flagged `latexmk` invocation when running
in SaaS / multi-tenant mode.

## Build

```sh
docker build -t flowtex/compile-sandbox:tl-2025 compile-sandbox/
```

The tag suffix is the TeX Live year for clarity; the Bookworm base
ships TeX Live 2022. If you need a newer year, swap the apt packages
for a TUG install (the same approach `scripts/install-texlive-year.sh`
uses on the bare-metal install path).

## Enable on the server

```sh
export FLOWTEX_COMPILE_SANDBOX=docker
export FLOWTEX_COMPILE_IMAGE=flowtex/compile-sandbox:tl-2025
```

Tune (defaults shown):

```sh
export FLOWTEX_COMPILE_MEMORY=2g       # docker --memory + --memory-swap
export FLOWTEX_COMPILE_PIDS_LIMIT=256  # docker --pids-limit
export FLOWTEX_COMPILE_CPUS=2.0        # docker --cpus
export FLOWTEX_COMPILE_TMPFS_SIZE=512m # docker tmpfs size for /tmp
export FLOWTEX_COMPILE_USER=1000:1000  # docker --user
export FLOWTEX_DOCKER_BIN=docker       # path to docker CLI if not on $PATH
```

## What's locked down

- `--network=none` -- TeX can't open sockets. Closes `\input{|...}` -style
  network escapes that have surfaced in TeX over the years.
- `--read-only` -- root fs is read-only. Only `/tmp` (tmpfs, bounded
  size) and the mounted project working dir are writeable.
- `--memory` + `--memory-swap` equal -- no swap. RSS cap is the
  total memory budget.
- `--pids-limit` -- fork-bomb cap inside the container.
- `--cpus` -- CPU cap matched to the JS timeout window + a small
  grace.
- `--user=1000:1000` + `--cap-drop=ALL` + `--security-opt=no-new-privileges`
  -- unprivileged process inside an unprivileged container.
- `openin_any=p` / `openout_any=p` -- engine-level kill switch
  (set inside `run-latexmk.sh` as defence-in-depth; the caller also
  passes `--no-shell-escape`).

## What's NOT locked down (by design)

- The project working directory is mounted read-write. The compile
  has to be able to write `.aux`, `.log`, `.pdf`, etc. The mount is
  the only path the container can persist anything to; everything
  else is tmpfs that disappears at exit.

## Daemon access

The FlowTex server process must reach the Docker daemon. Three
deployment shapes:

1. **Docker-in-Docker**: server is itself a container; mount
   `/var/run/docker.sock`.
2. **Sidecar daemon**: server runs on a VM; Docker daemon runs as
   `systemd --user` for the same UID as the FlowTex server.
3. **Remote daemon**: server connects to a dedicated compile host
   via `DOCKER_HOST=tcp://compile-host:2376`. The cleanest
   horizontal-scaling pattern.

Overleaf's CLSI uses pattern (1) with a sibling-containers
configuration; FlowTex's persistor abstraction (item 2) keeps
project blobs reachable from any pattern.
