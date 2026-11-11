# Native container execution needs no in-container control-plane server.
# Match sandbox-shim to the @cloudflare/sandbox package version.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=docker.io/cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

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
    bash \
    coreutils \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The official patched release precedes its npm and Docker tags. Verify its
# native binary rather than retaining the older bootstrap runtime.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) node_arch=x64; node_sha=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864 ;; \
      arm64) node_arch=arm64; node_sha=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd ;; \
      *) echo "Unsupported Node architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v26.13.1/node-v26.13.1-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    echo "${node_sha}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local/bin --strip-components=2 "node-v26.13.1-linux-${node_arch}/bin/node"; \
    rm /tmp/node.tar.xz; \
    test "$(node --version)" = "v26.13.1"

# Workspace root used by the sandbox service. All /v1/sandbox/:id/file/* and
# /v1/sandbox/:id/exec cwd paths must resolve inside /workspace.
RUN mkdir -p /workspace

WORKDIR /workspace
CMD ["sleep", "infinity"]
