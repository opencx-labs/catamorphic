/** Bun-only build tools use this surface without adding Bun globals to Electron's types. */
declare const Bun: {
  build(options: {
    entrypoints: string[];
    target: "bun";
    packages: "bundle" | "external";
    external?: string[];
    metafile?: boolean;
  }): Promise<{
    success: boolean;
    outputs: Array<{ text(): Promise<string> }>;
    logs: unknown[];
    metafile?: { inputs: Record<string, unknown> };
  }>;
};

export const build = Bun.build;
