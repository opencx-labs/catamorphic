# The Work server (ADR 0059, 0159). Releases publish this image to the GitHub
# Container Registry of the repository owner as `work-server`. Build it
# locally from the REPO ROOT:
#
#   docker build -f apps/server/Dockerfile -t work-server .
#   docker run -v work-data:/data -p 4700:4700 \
#     -e ANTHROPIC_API_KEY=sk-... work-server
#
# Everything lives in /data (PGlite, project repos, credentials, sandboxes).
# Mount it or lose it. For LAN discovery (http://work-<id>.local:4700) run
# with --network host on Linux; mDNS multicast does not cross the default
# bridge (macOS/Windows Docker cannot host-network, so use the IP links the
# invite response also carries).
# The setup listener binds to 127.0.0.1:4701 inside the container and is not
# exposed. Setup agents invoke it from inside the container.
#
# The same image runs an enrolled worker (ADR 0164), which holds no database
# URL or secrets and dials out to the control plane:
#
#   docker run -v work-worker-data:/data \
#     -e WORK_CONTROL_PLANE_URL=https://brain.example.com \
#     -e WORK_WORKER_ENROLLMENT=<one-time code> \
#     work-server bun apps/server/src/worker.ts
FROM oven/bun:1.3.14

# The local-process execution provider (ADR 0047) runs agent/workflow
# commands as plain processes: the container IS the sandbox. bash + git
# are its runtime contract.
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
# Packages (dists the server resolves) + the mobile PWA the server serves
# at its root (invite webLinks open it directly).
# --ignore-scripts: the workspace's pinned `node` helper package installs a
# Node binary through npm in its preinstall step; the image has bun only, and
# every build here runs under bun.
RUN bun install --frozen-lockfile --ignore-scripts \
  && bunx turbo run build --filter='./packages/*' --filter=catamorphic-pwa --no-daemon \
  && rm -rf /root/.bun/install/cache \
  && mkdir -p /data \
  && chown bun:bun /data

# The server and every local-process sandbox run as the unprivileged image
# user. The application tree stays root-owned and read-only to them.
USER bun
ENV WORK_DATA_DIR=/data
ENV PORT=4700
VOLUME /data
EXPOSE 4700

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? '4700') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "apps/server/src/index.ts"]
