import { dockerfileDigest } from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { dockerImageBuilder } from "../image-builder.js";
import { MicrosandboxSandboxProvider } from "../sandbox-provider.js";

// Real microVMs: WORK_TEST_MICROSANDBOX=1 with MSB_PATH naming the SDK's msb
// (see scripts/dev.ts). Pulls docker:dind and bash on first use.
const enabled = process.env.WORK_TEST_MICROSANDBOX === "1";

describe.skipIf(!enabled)("microsandbox Environments (ADR 0176)", () => {
  it("runs Docker and docker compose inside the VM, gone with it", async () => {
    const provider = new MicrosandboxSandboxProvider({
      namePrefix: "test-containers",
      memoryMib: 2048,
      containerDiskMib: 4096,
    });
    const sandbox = await provider.createSandbox({
      image: { kind: "oci", reference: "docker:dind" },
      containers: true,
    });
    try {
      const run = await provider.executeCommand(
        sandbox.id,
        "docker run --rm alpine echo nested-ok",
        { timeout: 300 },
      );
      expect(run.result).toContain("nested-ok");
      const compose = await provider.executeCommand(
        sandbox.id,
        "mkdir -p /tmp/c && cd /tmp/c && printf 'services:\\n  web:\\n    image: alpine\\n    command: sleep 60\\n' > compose.yml && docker compose up -d && docker compose ps -q | wc -l",
        { timeout: 300 },
      );
      expect(compose.exitCode, compose.result).toBe(0);
      // A stopped and restarted VM brings its daemon back.
      await provider.stopSandbox(sandbox.id);
      await provider.startSandbox(sandbox.id);
      const again = await provider.executeCommand(
        sandbox.id,
        "docker info --format '{{.ServerVersion}}'",
        { timeout: 60 },
      );
      expect(again.exitCode, again.result).toBe(0);
    } finally {
      await provider.destroySandbox(sandbox.id);
    }
  }, 900_000);

  it.skipIf(!process.env.WORK_TEST_DOCKER_SOCKET)(
    "boots an image built from a project Dockerfile",
    async () => {
      const dockerfile = `FROM bash\nRUN echo built-${Date.now()} > /built\n`;
      const provider = new MicrosandboxSandboxProvider({
        namePrefix: "test-image",
        setupCommand: "",
        imageBuilder: dockerImageBuilder(),
      });
      expect(provider.capabilities).toContain("images.build");
      const sandbox = await provider.createSandbox({
        image: {
          kind: "dockerfile",
          path: ".work/images/test.Dockerfile",
          content: dockerfile,
          digest: dockerfileDigest(dockerfile),
        },
      });
      try {
        const built = await provider.executeCommand(sandbox.id, "cat /built");
        expect(built.result).toContain("built-");
      } finally {
        await provider.destroySandbox(sandbox.id);
      }
    },
    900_000,
  );

  it("reaches only allowlisted hosts", async () => {
    const provider = new MicrosandboxSandboxProvider({
      namePrefix: "test-egress",
      // The bash image has bash and wget but no git; a restricted
      // Environment's image must bring what setup would otherwise install.
      setupCommand: "",
    });
    const sandbox = await provider.createSandbox({
      image: { kind: "oci", reference: "bash" },
      egress: { mode: "allowlist", allow: ["example.com"] },
    });
    try {
      const allowed = await provider.executeCommand(
        sandbox.id,
        "wget -q -T 10 -O- http://example.com | head -c 100",
        { timeout: 60 },
      );
      expect(allowed.result).toContain("Example Domain");
      const denied = await provider.executeCommand(
        sandbox.id,
        "wget -q -T 5 -O- http://www.wikipedia.org >/dev/null",
        { timeout: 60 },
      );
      expect(denied.exitCode).not.toBe(0);
    } finally {
      await provider.destroySandbox(sandbox.id);
    }
  }, 600_000);
});
