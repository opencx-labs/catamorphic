# A Linux machine for the container backend's real-sandbox tests
# (scripts/test-in-docker.sh): Docker's static engine from docker:dind, gVisor
# installed the documented way, Node for Vitest and Bun for the workspace. Run
# it privileged; its entrypoint starts the engine with a `runsc` runtime.
# Every version is pinned, so an upstream release never changes a test run;
# move them forward deliberately, gVisor with the CI job's.
FROM docker:29.8.2-dind AS docker

FROM node:24.13.0-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 ca-certificates curl git iptables procps \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/ /usr/local/bin/
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# gVisor's release archive (https://gvisor.dev/docs/user_guide/install/) of
# one dated release, checked against the SHA-512 recorded here. runsc runs
# its sidecars from gvisor-bin/ beside it, so the whole archive is unpacked.
ARG GVISOR_RELEASE=20260928
RUN set -e; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64) sum=c8d3a9fd4d4c4f5b8ff213caa4517356be128d18659ec4cde37828fe797f61a9725a602a846c81a8ed19c057a996515d31c081eba343ed4613a89951ba32ed59 ;; \
    aarch64) sum=926538a4f20056d44838f230297ecec9192db2562e2523a207295f706b76126725f2ff7b4e59d747147510c5714057eeec862a0f77d43bf625746592b5f51b00 ;; \
    *) echo "No gVisor checksum recorded for $arch" >&2; exit 1 ;; \
  esac; \
  cd /tmp; \
  curl -fsSLO "https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${arch}/gvisor.tar.bz2"; \
  echo "${sum}  gvisor.tar.bz2" | sha512sum -c -; \
  tar -xjf gvisor.tar.bz2 -C /usr/local/bin; \
  chmod a+rx /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1; \
  rm -f gvisor.tar.bz2; \
  runsc --version
RUN npm install -g bun@1.3.14 && bun --version
# Work's runtime arguments (ADR 0203): host sockets for the egress proxy,
# raw sockets for nested Docker.
RUN mkdir -p /etc/docker && printf '%s\n' \
  '{"runtimes":{"runsc":{"path":"/usr/local/bin/runsc","runtimeArgs":["--host-uds=open","--net-raw"]}}}' \
  > /etc/docker/daemon.json
ENTRYPOINT ["dind"]
CMD ["sh", "-c", "dockerd >/var/log/dockerd.log 2>&1 & exec sleep infinity"]
