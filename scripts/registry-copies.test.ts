import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRegistryCopies,
  normalize,
  packageName,
  type RegistryHost,
  syncRegistryCopies,
} from "./registry-copies.js";

it("every installed registry copy is the registry's, modulo imports", () => {
  expect(checkRegistryCopies()).toEqual([]);
});

describe("comparing a copy", () => {
  it("ignores how imports are spelled, joined and ordered", () => {
    const registry = [
      `import { a } from "@catamorphic/react";`,
      `import { ChatQueue, type HintComponent, TitleHint } from "../chat-queue/chat-queue.js";`,
      `import { ActivityText } from "./activity-text.js";`,
      `export const x = 1;`,
    ].join("\n");
    const installed = [
      `import { a } from "@catamorphic/react";`,
      `import { ActivityText } from "./activity-text";`,
      `import {`,
      `  ChatQueue,`,
      `  type HintComponent,`,
      `  TitleHint,`,
      `} from "./chat-queue.js";`,
      `export const x = 1;`,
    ].join("\n");
    expect(normalize(installed)).toBe(normalize(registry));
    expect(normalize(`${installed}\nexport const y = 2;`)).not.toBe(
      normalize(registry),
    );
  });

  it("names packages without their subpaths or versions", () => {
    expect(packageName("@pierre/diffs@^1.4.1")).toBe("@pierre/diffs");
    expect(packageName("@shikijs/langs/yaml")).toBe("@shikijs/langs");
    expect(packageName("shiki/core")).toBe("shiki");
    expect(packageName("lucide-react")).toBe("lucide-react");
  });
});

describe("checking installed copies", () => {
  let root: string;
  const host: RegistryHost = {
    name: "app",
    dir: "app/components",
    extension: ".js",
  };
  const write = (file: string, content: string) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const item = (
    name: string,
    files: Record<string, string>,
    dependencies: string[] = [],
  ) => {
    write(
      `packages/registry/src/${name}/registry-item.json`,
      JSON.stringify({
        name,
        dependencies,
        files: Object.keys(files).map((file) => ({
          path: `components/catamorphic/${file}`,
        })),
      }),
    );
    for (const [file, content] of Object.entries(files))
      write(`packages/registry/src/${name}/${file}`, content);
  };
  const check = (knownDrift: Record<string, string> = {}) =>
    checkRegistryCopies({ root, hosts: [host], knownDrift }).map(
      (problem) => `${problem.kind} ${problem.host}/${problem.file}`,
    );

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const setup = () => {
    root = mkdtempSync(path.join(os.tmpdir(), "registry-copies-"));
    item("queue", { "queue.tsx": `export const queue = 1;\n` });
    item(
      "timeline",
      {
        "timeline.tsx": [
          `import { z } from "zod/mini";`,
          `import { queue } from "../queue/queue.js";`,
          `import { steps } from "./steps.js";`,
          `export const timeline = [queue, steps, z];`,
          "",
        ].join("\n"),
        "steps.tsx": `import { useState } from "react";\nexport const steps = useState;\n`,
      },
      ["zod@^4.0.0"],
    );
  };

  it("passes copies installed by sync, and syncs only what is installed", () => {
    setup();
    write("app/components/queue.tsx", "old");
    expect(syncRegistryCopies({ root, host, knownDrift: {} })).toEqual([
      "app/components/queue.tsx",
    ]);
    expect(
      syncRegistryCopies({ root, host, item: "timeline", knownDrift: {} }),
    ).toEqual(["app/components/timeline.tsx", "app/components/steps.tsx"]);
    expect(
      readFileSync(path.join(root, "app/components/timeline.tsx"), "utf8"),
    ).toContain(`from "./queue.js"`);
    expect(check()).toEqual([]);
  });

  it("fails a copy that drifted, unless it is known, and a known one that came back", () => {
    setup();
    syncRegistryCopies({ root, host, item: "queue", knownDrift: {} });
    write("app/components/queue.tsx", `export const queue = 2;\n`);
    expect(check()).toEqual(["drift app/queue.tsx"]);
    expect(check({ "app/queue.tsx": "Ours." })).toEqual([]);
    // Sync leaves known drift alone unless the item is named.
    syncRegistryCopies({
      root,
      host,
      knownDrift: { "app/queue.tsx": "Ours." },
    });
    expect(check({ "app/queue.tsx": "Ours." })).toEqual([]);
    syncRegistryCopies({ root, host, item: "queue", knownDrift: {} });
    expect(check({ "app/queue.tsx": "Ours." })).toEqual([
      "stale-exception app/queue.tsx",
    ]);
    expect(check({ "app/gone.tsx": "Removed." })).toEqual([
      "stale-exception app/gone.tsx",
    ]);
  });

  it("fails an item installed in part", () => {
    setup();
    syncRegistryCopies({ root, host, item: "timeline", knownDrift: {} });
    syncRegistryCopies({ root, host, item: "queue", knownDrift: {} });
    rmSync(path.join(root, "app/components/steps.tsx"));
    expect(check()).toEqual([
      "partial app/timeline.tsx",
      "import app/timeline.tsx",
    ]);
  });

  it("fails a copy that reaches outside its item", () => {
    setup();
    syncRegistryCopies({ root, host, item: "queue", knownDrift: {} });
    write(
      "app/components/queue.tsx",
      [
        `import { pill } from "../pill";`,
        `import { left } from "left-pad";`,
        `import { react } from "@catamorphic/react";`,
        `export const queue = 1;`,
        "",
      ].join("\n"),
    );
    const problems = checkRegistryCopies({
      root,
      hosts: [host],
      knownDrift: {},
    })
      .filter((problem) => problem.kind === "import")
      .map((problem) => problem.detail);
    expect(problems).toEqual([
      "imports ../pill: an installed copy reaches only its own directory",
      "imports left-pad, which the queue item does not declare",
    ]);
  });
});
