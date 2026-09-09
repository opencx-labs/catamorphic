import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(root, ".agents/skills");
const files = [
  ...fs
    .readdirSync(skillRoot)
    .map((name) => path.join(skillRoot, name, "SKILL.md"))
    .filter((file) => fs.existsSync(file)),
  ...[
    "AGENTS.md",
    "DESIGN.md",
    ...fs
      .readdirSync(path.join(root, "apps/desktop/docs"))
      .map((name) => `docs/${name}`),
  ].map((file) => path.join(root, "apps/desktop", file)),
];
it.each(files)("agent guide links resolve: %s", (file) => {
  const text = fs.readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]?.split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    expect(
      fs.existsSync(
        path.resolve(path.dirname(file), decodeURIComponent(target)),
      ),
      `${file}: ${target}`,
    ).toBe(true);
  }
  if (file.endsWith("SKILL.md")) {
    expect(text).toMatch(/^---\nname: [a-z0-9-]+\ndescription: /);
  }
});

it("shared chat registry components match their installed desktop copies", () => {
  for (const name of ["agent-chat", "chat-queue", "tool-permission-card"]) {
    const source = fs
      .readFileSync(
        path.join(root, `packages/registry/src/${name}/${name}.tsx`),
        "utf8",
      )
      .replaceAll("../chat-timeline/chat-timeline.js", "./chat-timeline")
      .replaceAll("../todo-progress/todo-progress.js", "./todo-progress")
      .replaceAll(
        "../tool-permission-card/tool-permission-card.js",
        "./tool-permission-card",
      );
    const installed = fs.readFileSync(
      path.join(
        root,
        `apps/desktop/src/renderer/components/catamorphic/${name}.tsx`,
      ),
      "utf8",
    );
    expect(installed).toBe(source);
  }
});
