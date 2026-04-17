# Container image for catamorphic-sandbox-bridge.
#
# Extends the Cloudflare Sandbox base image (which includes the control-plane
# server on port 3000) and pre-installs the tooling workflow runs need. Keep
# this image tag in sync with the @cloudflare/sandbox npm version in
# package.json — they are released together.
FROM docker.io/cloudflare/sandbox:0.8.11

# Common tooling used by workflows / agents:
#   tar        - workspace persist / hydrate
#   git        - version control (cloning from Artifacts once it lands)
#   curl/wget  - HTTP fetching
#   ripgrep    - fast text + file search (rg)
#   jq         - JSON processing
#   procps     - ps / pkill / kill
#   sed/gawk   - text processing
#   unzip      - release asset extraction (bun installer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tar \
    git \
    curl \
    wget \
    ripgrep \
    jq \
    procps \
    sed \
    gawk \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# fusermount needs /etc/mtab to find active mounts; the base image ships
# without it, which breaks bucket unmount.
RUN ln -sf /proc/mounts /etc/mtab

# Install Bun system-wide under /usr/local so workflow runs can
# `bun run harness.ts` from any user. The official installer treats any
# positional arg as a version tag (no `--no-completions` flag exists), so we
# invoke it bare and rm completions out of the install tree after.
RUN curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf /root/.bun

# Workspace root used by the sandbox service. All /v1/sandbox/:id/file/* and
# /v1/sandbox/:id/exec cwd paths must resolve inside /workspace.
RUN mkdir -p /workspace

# Non-root user for sandbox.exec() — limits blast radius from workflow code.
RUN useradd -m -s /bin/bash -d /home/sandbox sandbox \
    && chown sandbox:sandbox /workspace \
    && chmod 700 /root

USER sandbox
WORKDIR /workspace
