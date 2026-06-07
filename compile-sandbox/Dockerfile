# SAAS-FOUNDATIONS item 1 -- FlowTex compile sandbox image.
#
# Built once per TeX Live year:
#
#   docker build -t flowtex/compile-sandbox:tl-2025 compile-sandbox/
#
# Then pointed at by FLOWTEX_COMPILE_IMAGE in the server's env when
# FLOWTEX_COMPILE_SANDBOX=docker.
#
# Design choices vs Overleaf's CLSI image:
#   - Smaller default: we install texlive-latex-extra +
#     texlive-fonts-extra + texlive-bibtex-extra + texlive-science +
#     texlive-pictures rather than texlive-full. Common LaTeX
#     papers compile; users who need an unusual package can run a
#     "fat" variant tag.
#   - Non-root from boot. The Overleaf model also runs as a non-
#     root user once inside the container.
#   - latexmk + biber + the synctex tool only; no shell, no curl,
#     no compilers. If your TeX source asks for shell-escape it
#     fails fast.

# texlive-base (Debian bookworm) is the maintained source for
# pdflatex / xelatex / lualatex / latexmk.
FROM debian:bookworm-slim

# DEBIAN_FRONTEND silences debconf; tzdata is a transitive of
# texlive-latex-extra in some mirrors and would otherwise hang on
# the build.
ENV DEBIAN_FRONTEND=noninteractive

# Pinned package set. Bookworm ships TeX Live 2022 by default;
# operators who need a newer year build a separate tag using the
# upstream TUG install (the install-texlive-year.sh script in
# scripts/ produces the same).
RUN apt-get update && apt-get install -y --no-install-recommends \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-fonts-recommended \
        texlive-fonts-extra \
        texlive-bibtex-extra \
        texlive-science \
        texlive-pictures \
        texlive-pstricks \
        texlive-publishers \
        texlive-luatex \
        texlive-xetex \
        biber \
        latexmk \
        ghostscript \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
             /usr/share/doc/* \
             /usr/share/locale/* \
             /usr/share/man/*

# texlive-publishers: IEEEtran, ACM, Springer/LNCS, Elsevier, AAAI,
# and most other journal/conference document classes academic users
# care about. Found missing during the first real compile against
# the sandbox -- the integration tests used \\documentclass{article}
# and so never exercised \\documentclass{IEEEtran}. Worth ~80 MB of
# extra image size to make the sandbox a drop-in for typical CS /
# engineering papers.

# A locked-down non-root user for the actual compile. uid:gid 1000:1000
# matches the SANDBOX_DEFAULTS in services/dockerCompileSandbox.js;
# operators who use a different uid pass --user at run time.
RUN groupadd -g 1000 latex && useradd -u 1000 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin latex

COPY run-latexmk.sh /usr/local/bin/run-latexmk.sh
RUN chmod 0755 /usr/local/bin/run-latexmk.sh

# Image runs the sandbox script as PID 1. It forwards the rest of
# the argv straight to latexmk, so the server-side argv builder is
# the only thing that needs to know how to invoke a compile.
USER 1000:1000
WORKDIR /workdir

ENTRYPOINT ["/usr/local/bin/run-latexmk.sh"]
