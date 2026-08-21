import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectDefaultAgentSlug,
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
    expect(
      JSON.parse(fs.readFileSync(manifestPath(root), "utf-8")).name,
    ).toBe("acme");
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
