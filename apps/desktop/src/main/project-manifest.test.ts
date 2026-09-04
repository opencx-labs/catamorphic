import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectDefaultAgentSlug,
  projectStartingActions,
  setProjectDefaultAgentSlug,
} from "./project-manifest.js";

const tmpdirs: string[] = [];
function projectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("project manifest startingActions", () => {
  it("returns no trace for an unconfigured project", () => {
    expect(
      projectStartingActions(projectRoot(), {
        root: false,
        builder: false,
        permissions: [],
      }),
    ).toEqual([]);
  });

  it("filters actions using resolved project authority", () => {
    const root = projectRoot();
    fs.mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    fs.writeFileSync(
      manifestPath(root),
      `${JSON.stringify({
        startingActions: [
          { label: "Draft follow-up", prompt: "Draft the follow-up" },
          {
            label: "Prepare QBR",
            prompt: "Prepare the QBR",
            agent: "csm",
            when: {
              builder: false,
              permissions: ["brain:maintain"],
            },
          },
          {
            label: "Review changes",
            prompt: "Review the working tree",
            when: { builder: true },
          },
          {
            label: "Malformed targeting fails closed",
            prompt: "This must not leak into every segment",
            when: { permissions: ["not-namespaced"] },
          },
          { label: "Broken" },
        ],
      })}\n`,
    );

    expect(
      projectStartingActions(root, {
        root: false,
        builder: false,
        permissions: ["brain:maintain"],
      }),
    ).toEqual([
      { label: "Draft follow-up", prompt: "Draft the follow-up" },
      { label: "Prepare QBR", prompt: "Prepare the QBR", agent: "csm" },
    ]);
    expect(
      projectStartingActions(root, {
        root: false,
        builder: true,
        permissions: [],
      }),
    ).toEqual([
      { label: "Draft follow-up", prompt: "Draft the follow-up" },
      { label: "Review changes", prompt: "Review the working tree" },
    ]);
  });
});

const manifestPath = (root: string) =>
  path.join(root, ".catamorphic", "project.json");

describe("project manifest defaultAgent", () => {
  it("reads nothing from a project without a manifest", () => {
    expect(projectDefaultAgentSlug(projectRoot())).toBeUndefined();
  });

  it("sets, reads, and clears — preserving unknown manifest keys", () => {
    const root = projectRoot();
    fs.mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    fs.writeFileSync(
      manifestPath(root),
      `${JSON.stringify({ name: "acme", future: { key: 1 } })}\n`,
    );

    setProjectDefaultAgentSlug(root, "triage");
    expect(projectDefaultAgentSlug(root)).toBe("triage");
    const raw = JSON.parse(fs.readFileSync(manifestPath(root), "utf-8"));
    expect(raw.name).toBe("acme");
    expect(raw.future).toEqual({ key: 1 });

    setProjectDefaultAgentSlug(root, null);
    expect(projectDefaultAgentSlug(root)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(manifestPath(root), "utf-8")).name).toBe(
      "acme",
    );
  });

  it("creates the manifest when a project has none yet", () => {
    const root = projectRoot();
    setProjectDefaultAgentSlug(root, "reviewer");
    expect(projectDefaultAgentSlug(root)).toBe("reviewer");
  });

  it("tolerates a broken manifest (no default rather than a throw)", () => {
    const root = projectRoot();
    fs.mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    fs.writeFileSync(manifestPath(root), "{nope");
    expect(projectDefaultAgentSlug(root)).toBeUndefined();
  });
});
