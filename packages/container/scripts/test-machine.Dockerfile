# A Linux machine for the container backend's real-sandbox tests
# (scripts/test-in-docker.sh): Docker's static engine from docker:dind, gVisor
# installed the documented way, Node for Vitest and Bun for the workspace. Run
# it privileged; its entrypoint starts the engine with a `runsc` runtime.
FROM docker:dind AS docker

FROM node:24.13.0-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates curl git iptables procps \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/ /usr/local/bin/
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# gVisor's release archive (https://gvisor.dev/docs/user_guide/install/),
# checked against its published SHA-512. runsc runs its sidecars from
# gvisor-bin/ beside it, so the whole archive is unpacked.
RUN set -e; \
  url="https://storage.googleapis.com/gvisor/releases/release/latest/$(uname -m)"; \
  cd /tmp; \
  curl -fsSLO "${url}/gvisor.tar.bz2" -O "${url}/gvisor.tar.bz2.sha512"; \
  sha512sum -c gvisor.tar.bz2.sha512; \
  tar -xjf gvisor.tar.bz2 -C /usr/local/bin; \
  chmod a+rx /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1; \
  rm -f gvisor.tar.bz2 gvisor.tar.bz2.sha512; \
  runsc --version
RUN npm install -g bun@1.3.14 && bun --version
# Work's runtime arguments (ADR 0203): host sockets for the egress proxy,
# raw sockets for nested Docker.
RUN mkdir -p /etc/docker && printf '%s\n' \
  '{"runtimes":{"runsc":{"path":"/usr/local/bin/runsc","runtimeArgs":["--host-uds=open","--net-raw"]}}}' \
  > /etc/docker/daemon.json
ENTRYPOINT ["dind"]
CMD ["sh", "-c", "dockerd >/var/log/dockerd.log 2>&1 & exec sleep infinity"]
