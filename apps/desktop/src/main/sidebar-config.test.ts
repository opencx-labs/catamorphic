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
  `module.exports = { left: [{ id: "project", title: "Project", sections: [{ id: "widget-1", type: "custom", title: ${JSON.stringify(
    title,
  )}, items: [] }] }], right: [] };\n`;

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
    expect(resolved.config.left[0]!.sections[0]?.title).toBe("Profile");
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
    expect(resolved.config.left[0]!.sections[0]?.title).toBe("Project");
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
    expect(resolved.config.left[0]!.sections[0]?.title).toBe("Local");
  });

  it("skips project layers when no projectId/projectRoot is given", () => {
    const { profileDir, projectRoot } = makeLayers({
      project: CUSTOM("Project"),
      profile: CUSTOM("Profile"),
    });
    void projectRoot;
    const resolved = resolveSidebarConfig({ profileDir });
    expect(resolved.layer).toBe("profile");
    expect(resolved.config.left[0]!.sections[0]?.title).toBe("Profile");
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
      projectLocal: `module.exports = { left: [{ id: "project", title: "Project", sections: [{ id: "widget-2", type: "bogus" }] }], right: [] };`,
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
      project: `module.exports = { left: [{ id: "project", title: "Project", sections: [
        { id: "widget-3", type: "workflows", collapsed: true },
        { id: "widget-4", type: "files", title: "Customer work" },
        { id: "widget-6", type: "custom", title: "Docs", items: [
          { label: "MDN", url: "https://developer.mozilla.org" },
          { label: "no url" },
        ] },
      ] }], right: [] };`,
    });
    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });
    expect(resolved.config.left[0]!.sections).toHaveLength(3);
    expect(resolved.config.left[0]!.sections[0]).toMatchObject({
      type: "workflows",
      collapsed: true,
    });
    expect(resolved.config.left[0]!.sections[1]).toMatchObject({
      type: "files",
      title: "Customer work",
    });
    expect(resolved.config.left[0]!.sections[2]?.items).toHaveLength(1);
    expect(resolved.config.left[0]!.sections[2]?.items?.[0]).toMatchObject({
      label: "MDN",
      url: "https://developer.mozilla.org",
    });
  });

  it("preserves valid capability predicates and drops invalid ones", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      project: `module.exports = { left: [{ id: "project", title: "Project", sections: [
        {
          id: "widget-9", type: "custom",
          title: "Brain",
          when: { permissions: ["brain:maintain"] },
          items: [
            {
              label: "Changes",
              url: "https://example.test/changes",
              when: { builder: false, permissions: ["changes:author"] },
            },
            {
              label: "Leaky",
              url: "https://example.test/leaky",
              when: { permissions: ["not-namespaced"] },
            },
          ],
        },
      ] }], right: [] };`,
    });
    const section = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    }).config.left[0]!.sections[0];
    expect(section?.when).toEqual({ permissions: ["brain:maintain"] });
    expect(section?.items).toEqual([
      expect.objectContaining({
        label: "Changes",
        when: {
          builder: false,
          permissions: ["changes:author"],
        },
      }),
    ]);
  });

  it("retains recursive custom items and folder-only nodes", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({
      project: `module.exports = { left: [{ id: "project", title: "Project", sections: [{
        id: "widget-10", type: "custom",
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
      }] }], right: [] };`,
    });

    const item = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    }).config.left[0]!.sections[0]?.items?.[0];
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
      project: `module.exports = { left: [{ id: "project", title: "Project", sections: [{
        id: "widget-11", type: "custom",
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
      }] }], right: [] };`,
    });

    const resolved = resolveSidebarConfig({
      profileDir,
      projectId,
      projectRoot,
    });

    expect(resolved.config.left[0]!.sections[0]?.items?.[0]?.preview).toEqual({
      title: "Production deployments",
      description: "Release health at a glance",
      metadata: [
        { label: "Owner", value: "Platform" },
        { label: "Region", value: "eu-west-1" },
        { label: "Status", value: "Healthy" },
        { label: "Version", value: "2026.8.24" },
      ],
    });
    expect(resolved.config.left[0]!.sections[0]?.items?.[1]?.preview).toBe(
      false,
    );
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

describe("tabbed layout reloads", () => {
  it("retains the last valid layout across invalid saves and recovers", () => {
    const profileDir = makeDir();
    const file = path.join(profileDir, "sidebar.js");
    fs.writeFileSync(file, CUSTOM("Original"));
    const original = resolveSidebarConfig({ profileDir }).config;
    fs.writeFileSync(file, "module.exports = {");
    const broken = resolveSidebarConfig({ profileDir });
    expect(broken.config).toEqual(original);
    expect(broken.error).toBeTruthy();
    fs.writeFileSync(file, CUSTOM("Updated"));
    const recovered = resolveSidebarConfig({ profileDir });
    expect(recovered.error).toBeUndefined();
    expect(recovered.config.left[0]?.sections[0]?.title).toBe("Updated");
  });

  it("accepts empty sides and rejects duplicate identities atomically", () => {
    const profileDir = makeDir();
    const file = path.join(profileDir, "sidebar.js");
    fs.writeFileSync(file, "module.exports = { left: [], right: [] }");
    expect(resolveSidebarConfig({ profileDir }).config).toEqual({
      left: [],
      right: [],
    });
    fs.writeFileSync(
      file,
      `module.exports = { left: [{ id: 'same', title: 'One', sections: [] }], right: [{ id: 'same', title: 'Two', sections: [] }] }`,
    );
    const invalid = resolveSidebarConfig({ profileDir });
    expect(invalid.error).toContain("unique id");
    expect(invalid.config).toEqual({ left: [], right: [] });
  });

  it("validates app names and bounds compact heights without granting file access", () => {
    const profileDir = makeDir();
    const file = path.join(profileDir, "sidebar.js");
    fs.writeFileSync(
      file,
      `module.exports = { left: [], right: [{ id: 'apps', title: 'Apps', icon: 'Box', sections: [{id:'app', type:'app', app:'renewals', height:9999}]}] }`,
    );
    expect(
      resolveSidebarConfig({ profileDir }).config.right[0]?.sections[0],
    ).toMatchObject({ app: "renewals", height: 1200 });
    fs.writeFileSync(
      file,
      `module.exports = { left: [], right: [{ id: 'notes', title: 'Notes', sections: [{id:'note', type:'note', path:'../secrets'}]}] }`,
    );
    expect(resolveSidebarConfig({ profileDir }).error).toContain(
      "project-relative",
    );
  });
});

describe("shared sidebar contributions", () => {
  it("keeps source options, distinct action placements and sparse overrides", () => {
    const dir = makeDir();
    const file = path.join(dir, "sidebar.js");
    fs.writeFileSync(
      file,
      `module.exports = {left:[],right:[{id:"chat",title:"Chat",when:{surface:["chat"],session:true},sections:[{
      id:"children",type:"custom",source:{type:"subsessions",pageSize:25,groupBy:"agentId"},
      itemDefaults:{icon:"Bot",menu:[{label:"Open",action:"open-tab"}]},
      itemOverrides:{abc:{label:"Renamed"}},
      contextMenu:[],actions:[{label:"Beside",action:"open-side",icon:"Columns2"}]
    }]}]};`,
    );
    const section = loadSidebarConfigFile(file).right[0]?.sections[0];
    expect(section?.source).toMatchObject({
      type: "subsessions",
      pageSize: 25,
    });
    expect(section?.contextMenu).toEqual([]);
    expect(section?.itemOverrides?.abc).toEqual({ label: "Renamed" });
    expect(section?.itemDefaults?.icon).toBe("Bot");
    fs.writeFileSync(
      file,
      `module.exports={left:[],right:[{id:"chat",title:"Chat",sections:[{id:"children",type:"chats",actions:[{label:"Bad",action:"invented"}]}]}]};`,
    );
    expect(loadSidebarConfigFile(file).right[0]?.sections[0]).toEqual(section);
  });
});
