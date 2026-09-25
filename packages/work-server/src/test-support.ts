import { workServerConfigFromEnv } from "./config.js";
import type { WorkServerOptions } from "./server.js";

/** Test servers boot from the same env parser as the image. */
export function testServerOptions(args: {
  dataDir: string;
  publicBases?: string[];
  env: Record<string, string | undefined>;
}): WorkServerOptions {
  return {
    config: {
      ...workServerConfigFromEnv(args.env),
      dataDir: args.dataDir,
      ...(args.publicBases ? { publicBases: args.publicBases } : {}),
    },
  };
}
