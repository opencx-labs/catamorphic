import { createHash } from "node:crypto";
import path from "node:path";

export type DevTarget = "all" | "desktop" | "server";

export function sanitizeInstanceName(input: string): string {
  const sanitized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(
      "Development instance name must contain a letter or number",
    );
  }
  return sanitized;
}

export function createDevPlan(input: {
  rootPath: string;
  tempPath: string;
  instanceOverride?: string;
  target: DevTarget;
  ports: {
    desktopCdp: number;
    desktopVite: number;
    server: number;
    operator: number;
  };
}): {
  instance: string;
  env: Record<string, string>;
  turboArgs: string[];
  desktopDataDir: string;
  serverDataDir: string;
  lockPath: string;
} {
  const rootHash = createHash("sha256")
    .update(input.rootPath)
    .digest("hex")
    .slice(0, 8);
  const instance =
    input.instanceOverride !== undefined
      ? sanitizeInstanceName(input.instanceOverride)
      : `${sanitizeInstanceName(path.basename(input.rootPath))}-${rootHash}`;
  const instanceRoot = path.join(input.tempPath, "catamorphic-dev", instance);
  const desktopDataDir = path.join(instanceRoot, "desktop");
  const serverDataDir = path.join(instanceRoot, "server");
  const filters =
    input.target === "all"
      ? ["--filter=catamorphic-desktop...", "--filter=catamorphic-server..."]
      : [`--filter=catamorphic-${input.target}...`];

  return {
    instance,
    env: {
      CATAMORPHIC_DESKTOP_DATA_DIR: desktopDataDir,
      CATAMORPHIC_DESKTOP_CDP_PORT: String(input.ports.desktopCdp),
      CATAMORPHIC_DESKTOP_VITE_PORT: String(input.ports.desktopVite),
      CATAMORPHIC_DATA_DIR: serverDataDir,
      PORT: String(input.ports.server),
      CATAMORPHIC_OPERATOR_PORT: String(input.ports.operator),
      CATAMORPHIC_PUBLIC_URL: `http://127.0.0.1:${input.ports.server}`,
      CATAMORPHIC_MDNS: "off",
    },
    turboArgs: ["run", "dev", "--no-daemon", "--concurrency=64", ...filters],
    desktopDataDir,
    serverDataDir,
    lockPath: path.join(instanceRoot, "dev.lock"),
  };
}
