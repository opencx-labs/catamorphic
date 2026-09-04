import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_CONFIG,
  loadSidebarConfigFile,
  resolveSidebarConfig,
  watchSidebarLayerFile,
} from "./sidebar-config.js";

const CUSTOM = (title: string) =>
  `module.exports = { sections: [{ type: "custom", title: ${JSON.stringify(
    title,
  )}, items: [] }] };\n`;

const tmpdirs: string[] = [];
const disposers: Array<() => void> = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-config-"));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A profileDir + projectRoot pair with optional layer files written. */
function makeLayers(files: {
  projectLocal?: string;
  project?: string;
  profile?: string;
}): { profileDir: string; projectRoot: string; projectId: string } {
  const profileDir = makeDir();
  const projectRoot = makeDir();
  const projectId = "proj-1";
  if (files.projectLocal !== undefined) {
    fs.mkdirSync(path.join(profileDir, "sidebar-projects"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(profileDir, "sidebar-projects", `${projectId}.js`),
      files.projectLocal,
    );
  }
  if (files.project !== undefined) {
    fs.mkdirSync(path.join(projectRoot, ".catamorphic"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".catamorphic", "sidebar.js"),
      files.project,
    );
  }
  if (files.profile !== undefined) {
    fs.writeFileSync(path.join(profileDir, "sidebar.js"), files.profile);
  }
  return { profileDir, projectRoot, projectId };
}

describe("resolveSidebarConfig", () => {
  it("falls back to the built-in default when no layer file exists", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({});
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    expect(resolved.layer).toBe("default");
    expect(resolved.config).toEqual(DEFAULT_SIDEBAR_CONFIG);
  });

  it("uses the profile layer when it is the only file", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      profile: CUSTOM("Profile"),
    });
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    expect(resolved.layer).toBe("profile");
    expect(resolved.config.sections[0]?.title).toBe("Profile");
  });

  it("prefers the project's shared .catamorphic/sidebar.js over the profile", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      project: CUSTOM("Project"),
      profile: CUSTOM("Profile"),
    });
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    expect(resolved.layer).toBe("project");
    expect(resolved.config.sections[0]?.title).toBe("Project");
  });

  it("prefers the user's project-local override over everything", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      projectLocal: CUSTOM("Local"),
      project: CUSTOM("Project"),
      profile: CUSTOM("Profile"),
    });
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    expect(resolved.layer).toBe("project-local");
    expect(resolved.config.sections[0]?.title).toBe("Local");
  });

  it("skips project layers when no projectId/projectRoot is given", () => {
    const { profileDir, projectRoot } = makeLayers({
      project: CUSTOM("Project"),
      profile: CUSTOM("Profile"),
    });
    void projectRoot;
    const resolved = resolveSidebarConfig({ profileDir });
    expect(resolved.layer).toBe("profile");
    expect(resolved.config.sections[0]?.title).toBe("Profile");
  });

  it("does NOT slide past a broken winning layer — it falls to defaults", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      project: "this is not javascript {",
      profile: CUSTOM("Profile"),
    });
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    // The broken project file wins the resolution (it exists) but yields
    // the defaults, exactly like a broken profile file always has.
    expect(resolved.layer).toBe("project");
    expect(resolved.config).toEqual(DEFAULT_SIDEBAR_CONFIG);
  });

  it("treats a config that sanitizes to zero sections as defaults", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      projectLocal: `module.exports = { sections: [{ type: "bogus" }] };`,
    });
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    expect(resolved.layer).toBe("project-local");
    expect(resolved.config).toEqual(DEFAULT_SIDEBAR_CONFIG);
  });

  it("sanitizes the winning layer like the profile store does", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      project: `module.exports = { sections: [
        { type: "workflows", collapsed: true },
        { type: "files", title: "Customer work" },
        { type: "not-a-type" },
        { type: "custom", title: "Docs", items: [
          { label: "MDN", url: "https://developer.mozilla.org" },
          { label: "no url" },
        ] },
      ] };`,
    });
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    expect(resolved.config.sections).toHaveLength(3);
    expect(resolved.config.sections[0]).toMatchObject({
      type: "workflows",
      collapsed: true,
    });
    expect(resolved.config.sections[1]).toMatchObject({
      type: "files",
      title: "Customer work",
    });
    expect(resolved.config.sections[2]?.items).toHaveLength(1);
    expect(resolved.config.sections[2]?.items?.[0]).toMatchObject({
      label: "MDN",
      url: "https://developer.mozilla.org",
    });
  });

  it("retains recursive custom items and folder-only nodes", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      project: `module.exports = { sections: [{
        type: "custom",
        title: "Knowledge",
        items: [{
          label: "Engineering",
          icon: "Folder",
          collapsed: true,
          items: [{
            label: "Platform",
            items: [{ label: "Runbook", url: "https://example.test/runbook" }],
          }],
        }],
      }] };`,
    });

    const item = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    }).config.sections[0]?.items?.[0];
    expect(item).toMatchObject({
      label: "Engineering",
      icon: "Folder",
      collapsed: true,
      items: [
        {
          label: "Platform",
          items: [{ label: "Runbook", url: "https://example.test/runbook" }],
        },
      ],
    });
  });

  it("sanitizes custom item previews and preserves an explicit opt-out", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      project: `module.exports = { sections: [{
        type: "custom",
        items: [
          {
            label: "Deployments",
            url: "https://deployments.example.test",
            preview: {
              title: "Production deployments",
              description: "Release health at a glance",
              metadata: [
                { label: "Owner", value: "Platform" },
                { label: "Region", value: "eu-west-1" },
                { label: "Status", value: "Healthy" },
                { label: "Version", value: "2026.8.24" },
                { label: "Ignored", value: "fifth row" },
                { label: "Missing value" },
              ],
            },
          },
          {
            label: "Quiet link",
            url: "https://quiet.example.test",
            preview: false,
          },
        ],
      }] };`,
    });

    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });

    expect(resolved.config.sections[0]?.items?.[0]?.preview).toEqual({
      title: "Production deployments",
      description: "Release health at a glance",
      metadata: [
        { label: "Owner", value: "Platform" },
        { label: "Region", value: "eu-west-1" },
        { label: "Status", value: "Healthy" },
        { label: "Version", value: "2026.8.24" },
      ],
    });
    expect(resolved.config.sections[0]?.items?.[1]?.preview).toBe(false);
  });
});

describe("loadSidebarConfigFile", () => {
  it("returns the defaults for a missing file", () => {
    const dir = makeDir();
    expect(loadSidebarConfigFile(path.join(dir, "nope.js"))).toEqual(
      DEFAULT_SIDEBAR_CONFIG,
    );
  });

  it("has no access to require/process in the sandbox", () => {
    const dir = makeDir();
    const file = path.join(dir, "sidebar.js");
    fs.writeFileSync(file, `require("node:fs"); module.exports = {};`);
    expect(loadSidebarConfigFile(file)).toEqual(DEFAULT_SIDEBAR_CONFIG);
  });
});

describe("watchSidebarLayerFile", () => {
  const changed = (file: string): Promise<void> =>
    new Promise((resolve) => {
      disposers.push(watchSidebarLayerFile(file, resolve));
    });

  it("fires when the file changes in an existing directory", async () => {
    const dir = makeDir();
    const file = path.join(dir, "sidebar.js");
    fs.writeFileSync(file, CUSTOM("one"));
    const fired = changed(file);
    // Give fs.watch a beat to attach before mutating.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(file, CUSTOM("two"));
    await fired;
  });

  it("fires when the directory is created after the watch starts", async () => {
    const root = makeDir();
    const file = path.join(root, ".catamorphic", "sidebar.js");
    const fired = changed(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, CUSTOM("late"));
    await fired;
  });
});
