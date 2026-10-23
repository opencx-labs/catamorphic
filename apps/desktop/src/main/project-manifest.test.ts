import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { publishedRef } from "@catamorphic/workflow/project-layout";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectDefaultAgentSlug,
  projectStartingActions,
  projectTrustedHosts,
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
            when: { permissions: ["brain:maintain"] },
          },
          {
            label: "Review changes",
            prompt: "Review the working tree",
            when: { permissions: ["program:write"] },
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
        permissions: ["brain:maintain"],
      }),
    ).toEqual([
      { label: "Draft follow-up", prompt: "Draft the follow-up" },
      { label: "Prepare QBR", prompt: "Prepare the QBR", agent: "csm" },
    ]);
    expect(
      projectStartingActions(root, {
        root: false,
        permissions: ["program:read", "program:write"],
      }),
    ).toEqual([
      { label: "Draft follow-up", prompt: "Draft the follow-up" },
      { label: "Review changes", prompt: "Review the working tree" },
    ]);
  });
});

const manifestPath = (root: string) => path.join(root, ".work", "project.json");

describe("published trusted hosts", () => {
  const write = (root: string, trustedHosts: unknown) => {
    fs.mkdirSync(path.dirname(manifestPath(root)), { recursive: true });
    fs.writeFileSync(manifestPath(root), JSON.stringify({ trustedHosts }));
  };
  const checkpoint = async (root: string) => {
    await nativeGit(root, ["add", ".work/project.json"]);
    await nativeGit(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture checkpoint",
    ]);
    return (await nativeGit(root, ["rev-parse", "HEAD"])).trim();
  };

  it("does not trust a plain folder or initialize Git", async () => {
    const root = projectRoot();
    write(root, ["attacker.example"]);
    expect(await projectTrustedHosts(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
  });

  it("trusts only the published list, including after local edits and checkpoint commits", async () => {
    const root = projectRoot();
    await nativeGit(root, ["init", "--initial-branch=main"]);
    write(root, [
      "Docs.Acme.test",
      "*.acme.dev",
      "docs.acme.test",
      "https://bad.example",
      null,
    ]);
    const approved = await checkpoint(root);
    expect(await projectTrustedHosts(root)).toEqual([]);
    await nativeGit(root, ["update-ref", publishedRef(), approved]);
    expect(await projectTrustedHosts(root)).toEqual([
      "docs.acme.test",
      "*.acme.dev",
    ]);
    write(root, ["attacker.example"]);
    expect(await projectTrustedHosts(root)).toEqual([
      "docs.acme.test",
      "*.acme.dev",
    ]);
    const draft = await checkpoint(root);
    expect(await projectTrustedHosts(root)).toEqual([
      "docs.acme.test",
      "*.acme.dev",
    ]);
    await nativeGit(root, ["update-ref", publishedRef(), draft]);
    expect(await projectTrustedHosts(root)).toEqual(["attacker.example"]);
  });

  it("does not inherit a parent repository's approved list", async () => {
    const parent = projectRoot();
    await nativeGit(parent, ["init", "--initial-branch=main"]);
    write(parent, ["parent.example"]);
    await nativeGit(parent, [
      "update-ref",
      publishedRef(),
      await checkpoint(parent),
    ]);
    const nested = path.join(parent, "plain-project");
    write(nested, ["attacker.example"]);
    expect(await projectTrustedHosts(nested)).toEqual([]);
  });

  it("grants no hosts from a missing or invalid published manifest", async () => {
    const root = projectRoot();
    await nativeGit(root, ["init", "--initial-branch=main"]);
    write(root, ["attacker.example"]);
    fs.writeFileSync(manifestPath(root), "{");
    await nativeGit(root, [
      "update-ref",
      publishedRef(),
      await checkpoint(root),
    ]);
    expect(await projectTrustedHosts(root)).toEqual([]);
  });
});

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
