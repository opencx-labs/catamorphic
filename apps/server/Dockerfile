# The stock Catamorphic server (ADR 0059). Build from the REPO ROOT:
#
#   docker build -f apps/server/Dockerfile -t catamorphic-server .
#   docker run -v catamorphic-data:/data -p 4700:4700 \
#     -e ANTHROPIC_API_KEY=sk-... catamorphic-server
#
# Everything lives in /data (PGlite, project repos, tokens, sandboxes) —
# mount it or lose it. For LAN discovery (http://catamorphic.local:4700)
# run with --network host on Linux; mDNS multicast does not cross the
# default bridge (macOS/Windows Docker cannot host-network — use the IP
# links the invite response also carries).
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
RUN bun install --frozen-lockfile \
  && bunx turbo run build --filter='./packages/*' --filter=catamorphic-pwa --no-daemon \
  && rm -rf /root/.bun/install/cache

ENV CATAMORPHIC_DATA_DIR=/data
ENV PORT=4700
VOLUME /data
EXPOSE 4700

CMD ["bun", "apps/server/src/index.ts"]
