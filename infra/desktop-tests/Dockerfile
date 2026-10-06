FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS node
# Debian 13 supplies the glibc >= 2.39 required by microsandbox's ARM binding.
FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f

RUN apt-get update && apt-get install --yes --no-install-recommends \
    ca-certificates git openssh-client python3 make g++ \
    xvfb xauth x11-utils xdotool openbox dbus-x11 libgtk-3-0 libnss3 libasound2 \
    libgbm1 libdrm2 libxss1 libxtst6 libatk-bridge2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
# Tests run unprivileged, as on CI runners: Electron refuses its sandboxed
# renderers as root, and extension service workers get Work's APIs only in
# those (ADR 0203). The base image's `bun` user (uid 1000) owns the tree.
RUN mkdir -p /workspace /artifacts && chown bun:bun /workspace /artifacts
USER bun
WORKDIR /workspace
# A separate manifest layer keeps Linux dependencies cached across source edits.
COPY --chown=bun:bun manifests/ ./
ARG TARGETARCH
RUN --mount=type=cache,id=catamorphic-desktop-user-bun-${TARGETARCH},target=/home/bun/.bun/install/cache,uid=1000,gid=1000,sharing=locked \
    --mount=type=cache,id=catamorphic-desktop-user-npm-${TARGETARCH},target=/home/bun/.npm,uid=1000,gid=1000,sharing=locked \
    bun install --frozen-lockfile \
    && cd apps/desktop && node -e "require('electron')"
COPY --chown=bun:bun source/ ./
RUN --mount=type=cache,id=catamorphic-desktop-user-turbo-${TARGETARCH},target=/workspace/.turbo/cache,uid=1000,gid=1000,sharing=locked \
    bun scripts/tool-runtime.ts turbo run build --no-daemon --concurrency=2 \
    --filter=catamorphic-desktop... --filter=catamorphic-pwa...
ENV CI=true
ENV SHELL=/bin/bash
ENV CATAMORPHIC_E2E_ARTIFACTS_DIR=/artifacts
ENTRYPOINT ["bun", "scripts/desktop-test.ts", "--native"]
