import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeSidebarSourcePage } from "../shared/source-rows.js";
import { chipsModule, executableSource } from "../shared/workspace-config.js";
import {
  DEFAULT_WORKSPACE_CONFIG,
  DEFAULT_WORKSPACE_FILE,
  loadWorkspaceConfigFile,
  resolveWorkspaceConfig,
  watchConfigLayerFile,
} from "./workspace-config.js";

const LINKS = (title: string) =>
  `module.exports = { sidebars: {left: [{ id: "project", title: "Project", sections: [{ id: "links", title: ${JSON.stringify(
    title,
  )}, items: [] }] }], right: [] } };\n`;

/** A layout whose left sidebar holds these sections (as source text). */
const sections = (body: string) =>
  `module.exports = { sidebars: {left: [{ id: "project", title: "Project", sections: [${body}] }], right: [] } };`;

const tmpdirs: string[] = [];
const disposers: Array<() => void> = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-config-"));
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
    fs.mkdirSync(path.join(profileDir, "workspace-projects"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(profileDir, "workspace-projects", `${projectId}.js`),
      files.projectLocal,
    );
  }
  if (files.project !== undefined) {
    fs.mkdirSync(path.join(projectRoot, ".work"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".work", "workspace.js"),
      files.project,
    );
  }
  if (files.profile !== undefined) {
    fs.writeFileSync(path.join(profileDir, "workspace.js"), files.profile);
  }
  return { profileDir, projectRoot, projectId };
}

/** Resolve a profile-only layout from source text. */
function resolveProfile(source: string) {
  const profileDir = makeDir();
  fs.writeFileSync(path.join(profileDir, "workspace.js"), source);
  return resolveWorkspaceConfig({ profileDir });
}

describe("resolveWorkspaceConfig", () => {
  it("falls back to the built-in default when no layer file exists", () => {
    const { profileDir, projectRoot, projectId } = makeLayers({});
    expect(
      resolveWorkspaceConfig({ profileDir, projectId, projectRoot }),
    ).toEqual({ config: DEFAULT_WORKSPACE_CONFIG, layer: "default" });
    // Work's own lists show where they continue by fading, never a thumb.
    expect(
      [
        ...DEFAULT_WORKSPACE_CONFIG.sidebars.left,
        ...DEFAULT_WORKSPACE_CONFIG.sidebars.right,
      ].flatMap((tab) =>
        tab.sections.filter((section) => section.scrollbar !== undefined),
      ),
    ).toEqual([]);
  });

  it("takes the most specific existing layer, whole", () => {
    const layers = makeLayers({
      projectLocal: LINKS("Mine"),
      project: LINKS("Shared"),
      profile: LINKS("Profile"),
    });
    const resolved = resolveWorkspaceConfig(layers);
    expect(resolved.layer).toBe("project-local");
    expect(resolved.config.sidebars.left[0]?.sections[0]?.title).toBe("Mine");
    const shared = makeLayers({
      project: LINKS("Shared"),
      profile: LINKS("Profile"),
    });
    expect(resolveWorkspaceConfig(shared).layer).toBe("project");
    expect(
      resolveWorkspaceConfig({ profileDir: shared.profileDir }).layer,
    ).toBe("profile");
  });

  it("does not slide past a broken winning layer: it falls to defaults", () => {
    const layers = makeLayers({
      project: "this is not javascript {",
      profile: LINKS("Profile"),
    });
    const resolved = resolveWorkspaceConfig(layers);
    expect(resolved.layer).toBe("project");
    expect(resolved.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(resolved.error).toBeTruthy();
  });

  it("refuses a committed layout from before ADR 0234 without rewriting it", () => {
    const old = sections(`{ id: "chats", type: "chats" }`);
    const layers = makeLayers({ project: old });
    const resolved = resolveWorkspaceConfig(layers);
    expect(resolved.error).toContain("sections have no type");
    expect(resolved.error).toContain("work:chats");
    expect(
      fs.readFileSync(
        path.join(layers.projectRoot, ".work", "workspace.js"),
        "utf8",
      ),
    ).toBe(old);
  });

  it("keeps sources, items and presentation", () => {
    const resolved = resolveProfile(
      sections(`
        { id: "flows", source: "work:workflows", collapsed: true, hideEmpty: true, scrollbar: true },
        { id: "pins", source: "work:pinned", title: "", presentation: "tiles", scrollbar: "yes" },
        { id: "todos", source: ".work/todos.ts", collections: ["tabs"], workflows: ["listTickets"] },
        { id: "docs", title: "Docs", items: [
          { label: "MDN", url: "https://developer.mozilla.org" },
          { label: "no url" },
        ] },
        { id: "monitor", app: "monitor", height: 9999, collections: ["chats"] },
        { id: "note", note: true },`),
    );
    expect(resolved.error).toBeUndefined();
    const [flows, pins, todos, docs, monitor, note] =
      resolved.config.sidebars.left[0]?.sections ?? [];
    expect(flows).toMatchObject({
      source: "work:workflows",
      collapsed: true,
      hideEmpty: true,
      scrollbar: true,
    });
    expect(pins).toMatchObject({ title: "", presentation: "tiles" });
    // A thumb is asked for with true; anything else leaves the faded edge.
    expect(pins).not.toHaveProperty("scrollbar");
    expect(todos).toMatchObject({
      source: ".work/todos.ts",
      collections: ["tabs"],
      workflows: ["listTickets"],
    });
    expect(docs?.items).toEqual([
      expect.objectContaining({
        label: "MDN",
        url: "https://developer.mozilla.org",
      }),
    ]);
    expect(monitor).toMatchObject({ app: "monitor", height: 1200 });
    expect(note).toMatchObject({ note: true });
  });

  it("refuses sources, grants and kinds that do not exist", () => {
    for (const [body, message] of [
      [`{ id: "a", source: "work:nonsense" }`, "not one of Work's lists"],
      [`{ id: "a", source: "https://example.com" }`, "not a module path"],
      [`{ id: "a", source: "work:tabs", items: [] }`, "exactly one of"],
      [`{ id: "a" }`, "exactly one of"],
      [
        `{ id: "a", source: "work:subsessions" }`,
        "add when: { session: true }",
      ],
      [
        `{ id: "a", source: "work:chats", collections: ["tabs"] }`,
        "only apps and modules",
      ],
      [
        `{ id: "a", source: ".work/x.ts", collections: ["work:tabs"] }`,
        "without work:",
      ],
      [`{ id: "a", app: "m", workflows: ["x"] }`, "only modules"],
      [`{ id: "a", note: "../secrets" }`, "project-relative"],
      [`{ id: "a", source: "work:tabs", presentation: "grid" }`, "rows"],
    ] as const) {
      expect(resolveProfile(sections(body)).error, body).toContain(message);
    }
  });

  it("checks actions: Work's verbs, source actions, input, no run:", () => {
    const resolved = resolveProfile(
      sections(`{ id: "todos", source: ".work/todos.ts",
        headerActions: [
          { label: "Add", action: "add", icon: "Plus",
            input: { title: "Add todo", submit: "Add",
              fields: [{ name: "text", label: "Todo", placeholder: "Milk" }] } },
          { label: "New tab", action: "open", url: "command:new-tab" },
        ],
        itemDefaults: { actions: [{ label: "Done", action: "mark-done" }],
          menu: [{ label: "Side", action: "open-side" }, { label: "Copy", action: "copy-url" }] } }`),
    );
    expect(resolved.error).toBeUndefined();
    const todos = resolved.config.sidebars.left[0]?.sections[0];
    expect(todos?.headerActions?.[0]?.input).toEqual({
      title: "Add todo",
      submit: "Add",
      fields: [{ name: "text", label: "Todo", placeholder: "Milk" }],
    });
    expect(todos?.headerActions?.[1]).toMatchObject({
      action: "open",
      url: "command:new-tab",
    });
    expect(todos?.itemDefaults?.menu?.map((entry) => entry.action)).toEqual([
      "open-side",
      "copy-url",
    ]);
    for (const [entry, message] of [
      [`{ label: "Toggle", action: "run:toggle" }`, "without run:"],
      [`{ label: "Bad", action: "Bad Name" }`, "not one of Work's verbs"],
      [`{ label: "Ask", action: "ask", input: { fields: [] } }`, "one to four"],
      [
        `{ label: "Ask", action: "ask", input: { fields: [{ name: "a", label: "A" }, { name: "a", label: "B" }] } }`,
        "unique name",
      ],
    ] as const)
      expect(
        resolveProfile(
          sections(`{ id: "a", source: ".work/a.ts", menu: [${entry}] }`),
        ).error,
        entry,
      ).toContain(message);
  });

  it("keeps valid conditions and drops what has an invalid one", () => {
    const resolved = resolveProfile(
      sections(`
        { id: "tabs", source: "work:tabs", when: { tabPlacement: "sidebar" } },
        { id: "gone", source: "work:files", when: { tabPlacement: "left" } },
        { id: "brain", title: "Brain", when: { permissions: ["brain:maintain"] }, items: [
          { label: "Changes", url: "https://example.test/changes", when: { permissions: ["changes:author"] } },
          { label: "Retired builder flag", url: "https://example.test/builder", when: { builder: true } },
        ] },`),
    );
    const [tabs, brain, extra] =
      resolved.config.sidebars.left[0]?.sections ?? [];
    expect(extra).toBeUndefined();
    expect(tabs?.when).toMatchObject({ tabPlacement: "sidebar" });
    expect(brain?.when).toEqual({ permissions: ["brain:maintain"] });
    expect(brain?.items).toEqual([
      expect.objectContaining({
        label: "Changes",
        when: { permissions: ["changes:author"] },
      }),
    ]);
  });

  it("keeps recursive items, folder-only nodes and previews of up to six facts", () => {
    const resolved = resolveProfile(
      sections(`{ id: "knowledge", title: "Knowledge", items: [{
        label: "Engineering", icon: "Folder", collapsed: true,
        items: [{ label: "Platform", items: [{ label: "Runbook", url: "https://example.test/runbook",
          preview: { title: "Runbook", metadata: [
            { label: "1", value: "a" }, { label: "2", value: "b" }, { label: "3", value: "c" },
            { label: "4", value: "d" }, { label: "5", value: "e" }, { label: "6", value: "f" },
            { label: "7", value: "dropped" }, { label: "no value" }] } }] }],
      }, { label: "Quiet", url: "https://quiet.example.test", preview: false }] }`),
    );
    const [engineering, quiet] =
      resolved.config.sidebars.left[0]?.sections[0]?.items ?? [];
    expect(engineering).toMatchObject({
      label: "Engineering",
      collapsed: true,
      items: [{ label: "Platform", items: [{ label: "Runbook" }] }],
    });
    expect(engineering?.items?.[0]?.items?.[0]?.preview).toMatchObject({
      metadata: ["1", "2", "3", "4", "5", "6"].map((label) => ({ label })),
    });
    expect(quiet?.preview).toBe(false);
  });
});

describe("rewriting a layout from before ADR 0234", () => {
  it("rewrites a profile file once, keeping the original beside it", () => {
    const profileDir = makeDir();
    const file = path.join(profileDir, "workspace.js");
    const old = `module.exports = { sidebars: {
      left: [{ id: "project", title: "Project", icon: "House", sections: [
        { id: "bookmarks", type: "bookmarks" },
        { id: "workflows", type: "workflows" },
        { id: "chats", type: "chats" },
        { id: "tabs", type: "tabs" },
        { id: "todos", type: "custom", title: "Todos",
          source: { type: "custom", module: ".work/todos.ts" },
          headerActions: [{ label: "Refresh", action: "refresh" }],
          itemDefaults: { actions: [{ label: "Done", action: "run:toggle" }] } },
        { id: "running", type: "custom", title: "Running",
          source: { type: "chats", filter: { running: true } } },
        { id: "note", type: "note", path: "notes/today.md" },
      ] }],
      right: [
        { id: "this-session", title: "This session", icon: "MessageSquareText",
          sections: [{ id: "session", type: "session", when: { session: true } }] },
        { id: "companion", title: "Activity", icon: "Activity", sections: [
          { id: "activity", type: "activity" },
          { id: "subsessions", type: "subsessions", when: { surface: ["chat"], session: true } },
          { id: "changes", type: "git", hideEmpty: true } ] },
        { id: "reviews", title: "Proposals", icon: "GitPullRequest",
          sections: [{ id: "prs", type: "prs" }] },
      ] },
      palette: { modes: [
        { id: "issues", trigger: "issues", title: "Issues", source: { type: "custom", module: ".work/issues.ts" } },
        { id: "chats-mode", trigger: "chatlist", title: "Chats", source: { type: "chats", filter: { running: true } } },
        { id: "kids", trigger: "kids", title: "Kids", source: { type: "chats", scope: "children" } },
      ] } };`;
    fs.writeFileSync(file, old);
    const resolved = resolveWorkspaceConfig({ profileDir });
    expect(resolved.error).toBeUndefined();
    expect(fs.readFileSync(`${file}.v1`, "utf8")).toBe(old);
    expect(fs.readFileSync(file, "utf8")).not.toContain('"type"');
    const left = resolved.config.sidebars.left[0]?.sections ?? [];
    expect(left.map((section) => section.id)).toEqual([
      "pinned",
      "library",
      "bookmarks",
      "workflows",
      "chats",
      "tabs",
      "todos",
      "running",
      "note",
    ]);
    expect(left.find((section) => section.id === "tabs")).toMatchObject({
      source: "work:tabs",
      when: { tabPlacement: "sidebar" },
    });
    expect(left.find((section) => section.id === "chats")).toMatchObject({
      source: "work:chats",
      headerActions: [{ url: "command:new-floating-chat" }],
    });
    expect(left.find((section) => section.id === "todos")).toMatchObject({
      source: ".work/todos.ts",
      itemDefaults: { actions: [{ action: "toggle" }] },
    });
    expect(left.find((section) => section.id === "running")).toMatchObject({
      source: "work:chats",
      title: "Running",
    });
    expect(left.find((section) => section.id === "note")).toMatchObject({
      note: "notes/today.md",
    });
    // The right sidebar's screens are gone; their lists stay as sources.
    expect(resolved.config.sidebars.right).toEqual([]);
    expect(resolved.config.palette?.modes.map((mode) => mode.id)).toEqual([
      "issues",
      "chats-mode",
    ]);
    expect(resolved.config.palette?.modes[0]?.source).toBe(".work/issues.ts");
    expect(resolved.config.palette?.modes[1]?.source).toBe("work:chats");
    // Once rewritten, it loads as written.
    expect(resolveWorkspaceConfig({ profileDir }).config).toEqual(
      resolved.config,
    );
  });

  it("leaves a layout it cannot make valid as it is, and keeps every original", () => {
    const profileDir = makeDir();
    const file = path.join(profileDir, "workspace.js");
    // run:markDone names an action today's pattern refuses.
    const invalid = `module.exports = { sidebars: { left: [{ id: "p", title: "P", icon: "House", sections: [
      { id: "todos", type: "custom", source: { type: "custom", module: ".work/todos.ts" },
        itemDefaults: { actions: [{ label: "Done", action: "run:markDone" }] } } ] }], right: [] } };`;
    fs.writeFileSync(file, invalid);
    const refused = resolveWorkspaceConfig({ profileDir });
    expect(refused.error).toContain("markDone");
    expect(fs.readFileSync(file, "utf8")).toBe(invalid);
    expect(fs.existsSync(`${file}.v1`)).toBe(false);
    // A second old layout after the first was rewritten keeps its own copy.
    const first = `module.exports = { sidebars: { left: [{ id: "p", title: "P", icon: "House", sections: [{ id: "chats", type: "chats" }] }], right: [] } };`;
    fs.writeFileSync(file, first);
    expect(resolveWorkspaceConfig({ profileDir }).error).toBeUndefined();
    const second = first.replace('"chats" }', '"apps" }');
    fs.writeFileSync(file, second);
    expect(resolveWorkspaceConfig({ profileDir }).error).toBeUndefined();
    expect(fs.readFileSync(`${file}.v1`, "utf8")).toBe(first);
    expect(fs.readFileSync(`${file}.v1-2`, "utf8")).toBe(second);
    expect(
      fs.readdirSync(profileDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("rewrites the untouched default copies every profile was given", () => {
    const profileDir = makeDir();
    fs.writeFileSync(
      path.join(profileDir, "workspace.js"),
      `module.exports = ${JSON.stringify({
        sidebars: {
          left: [
            {
              id: "project",
              title: "Project",
              icon: "House",
              sections: [
                { id: "bookmarks", type: "bookmarks" },
                { id: "workflows", type: "workflows" },
                { id: "apps", type: "apps" },
                { id: "chats", type: "chats" },
                { id: "tabs", type: "tabs" },
                { id: "files", type: "files", collapsed: true },
                { id: "remote", type: "remote", title: "Server" },
              ],
            },
          ],
          right: [
            {
              id: "reviews",
              title: "Proposals",
              icon: "GitPullRequest",
              sections: [{ id: "prs", type: "prs" }],
            },
          ],
        },
      })};`,
    );
    const resolved = resolveWorkspaceConfig({ profileDir });
    expect(resolved.error).toBeUndefined();
    expect(resolved.config.sidebars.right).toEqual([]);
    expect(
      resolved.config.sidebars.left[0]?.sections.find(
        (section) => section.id === "remote",
      ),
    ).toMatchObject({
      source: "work:remote",
      title: "Server",
      hideEmpty: true,
      headerActions: [{ action: "sync" }, { action: "upload-all" }],
    });
  });
});

describe("loadWorkspaceConfigFile", () => {
  it("returns the defaults for a missing file", () => {
    const dir = makeDir();
    expect(loadWorkspaceConfigFile(path.join(dir, "nope.js"))).toEqual(
      DEFAULT_WORKSPACE_CONFIG,
    );
  });

  it("has no access to require/process in the sandbox", () => {
    const dir = makeDir();
    const file = path.join(dir, "workspace.js");
    fs.writeFileSync(file, `require("node:fs"); module.exports = {};`);
    expect(loadWorkspaceConfigFile(file)).toEqual(DEFAULT_WORKSPACE_CONFIG);
  });

  it("gives a file nothing that reaches this process, and takes back only data", () => {
    const dir = makeDir();
    const file = path.join(dir, "workspace.js");
    // A host object in the context would hand over this realm's Function.
    fs.writeFileSync(
      file,
      `const reach = (value) => { try { return typeof value.constructor.constructor("return process")() } catch { return "none" } };
      if ([reach(module), reach(exports), reach(this)].some((kind) => kind === "object")) throw new Error("escaped");
      module.exports = { sidebars: { left: [], right: [] }, get palette() { throw new Error("ran here"); } };`,
    );
    const resolved = resolveWorkspaceConfig({ profileDir: dir });
    expect(resolved.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    // Its getter ran in its own context, while it was turned into data.
    expect(resolved.error).toContain("ran here");
    expect(resolved.error).not.toContain("escaped");
  });
});

describe("watchConfigLayerFile", () => {
  const changed = (file: string): Promise<void> =>
    new Promise((resolve) => {
      disposers.push(watchConfigLayerFile(file, resolve));
    });

  it("fires when the file changes in an existing directory", async () => {
    const dir = makeDir();
    const file = path.join(dir, "workspace.js");
    fs.writeFileSync(file, LINKS("one"));
    const fired = changed(file);
    // Give fs.watch a beat to attach before mutating.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(file, LINKS("two"));
    await fired;
  });

  it("fires when the directory is created after the watch starts", async () => {
    const root = makeDir();
    const file = path.join(root, ".work", "workspace.js");
    const fired = changed(file);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, LINKS("late"));
    await fired;
  });
});

describe("tabbed layout reloads", () => {
  it("retains the last valid layout across invalid saves and recovers", () => {
    const profileDir = makeDir();
    const file = path.join(profileDir, "workspace.js");
    fs.writeFileSync(file, LINKS("Original"));
    const original = resolveWorkspaceConfig({ profileDir }).config;
    fs.writeFileSync(file, "module.exports = {");
    const broken = resolveWorkspaceConfig({ profileDir });
    expect(broken.config).toEqual(original);
    expect(broken.error).toBeTruthy();
    fs.writeFileSync(file, LINKS("Updated"));
    const recovered = resolveWorkspaceConfig({ profileDir });
    expect(recovered.error).toBeUndefined();
    expect(recovered.config.sidebars.left[0]?.sections[0]?.title).toBe(
      "Updated",
    );
  });

  it("accepts empty sides and rejects duplicate identities atomically", () => {
    const profileDir = makeDir();
    const file = path.join(profileDir, "workspace.js");
    fs.writeFileSync(
      file,
      "module.exports = { sidebars: {left: [], right: [] } }",
    );
    expect(resolveWorkspaceConfig({ profileDir }).config).toEqual({
      sidebars: { left: [], right: [] },
    });
    fs.writeFileSync(
      file,
      `module.exports = { sidebars: {left: [{ id: 'same', title: 'One', sections: [] }], right: [{ id: 'same', title: 'Two', sections: [] }] } }`,
    );
    const invalid = resolveWorkspaceConfig({ profileDir });
    expect(invalid.error).toContain("unique id");
    expect(invalid.config).toEqual({ sidebars: { left: [], right: [] } });
  });
});

describe("palette modes", () => {
  const withModes = (modes: string, extra = "") =>
    `module.exports = { sidebars: {left: [{ id: "project", title: "Project", sections: [
      { id: "todos", source: ".work/todos.ts", collections: ["chats"] },
      { id: "kids", source: "work:subsessions", when: { session: true } },
      ${extra}
    ] }], right: [] }, palette: { modes: [${modes}] } };`;

  it("keeps modes over a source, a section or items", () => {
    const resolved = resolveProfile(
      withModes(`
        { id: "issues", trigger: "@Issues", aliases: ["bugs"], title: "Issues",
          source: ".work/issues.ts", search: "source", workflows: ["searchIssues"] },
        { id: "changes", trigger: "changes", title: "Changes", source: "work:git" },
        { id: "todo", trigger: "todo", title: "Todos", section: "todos", topLevel: true },
        { id: "runbooks", trigger: "runbook", title: "Runbooks",
          items: [{ label: "Deploy", url: "https://wiki.example.com/deploy" }] },`),
    );
    expect(resolved.error).toBeUndefined();
    const modes = resolved.config.palette?.modes ?? [];
    expect(modes[0]).toMatchObject({
      trigger: "issues",
      aliases: ["bugs"],
      source: ".work/issues.ts",
      search: "source",
      workflows: ["searchIssues"],
    });
    expect(modes[1]).toMatchObject({ source: "work:git", search: "palette" });
    expect(modes[2]).toMatchObject({ section: "todos", topLevel: true });
    expect(modes[3]?.items?.[0]).toMatchObject({ label: "Deploy" });
  });

  it("refuses modes the palette cannot serve", () => {
    for (const [mode, message] of [
      [
        `{ id: "k", trigger: "k", title: "K", source: "work:subsessions" }`,
        "needs a chat",
      ],
      [
        `{ id: "k", trigger: "k", title: "K", section: "kids" }`,
        "lists the chat in front",
      ],
      [
        `{ id: "k", trigger: "k", title: "K", source: "work:git", search: "source" }`,
        "needs an executable module",
      ],
      [
        `{ id: "k", trigger: "files", title: "K", source: "work:git" }`,
        "built-in mode",
      ],
      [
        `{ id: "todos", trigger: "k", title: "K", source: "work:git" }`,
        "distinct from section ids",
      ],
      [
        `{ id: "k", trigger: "k", title: "K", source: "work:git", section: "todos" }`,
        "exactly one of",
      ],
    ] as const)
      expect(resolveProfile(withModes(mode)).error, mode).toContain(message);
  });

  it("finds a module and its grants by section or mode id", () => {
    const config = resolveProfile(
      withModes(`
        { id: "issues", trigger: "issues", title: "Issues", source: ".work/issues.ts", collections: ["tabs"] },
        { id: "todo", trigger: "todo", title: "Todos", section: "todos" },`),
    ).config;
    expect(executableSource(config, "todos")).toEqual({
      module: ".work/todos.ts",
      collections: ["chats"],
      workflows: [],
    });
    expect(executableSource(config, "issues")).toEqual({
      module: ".work/issues.ts",
      collections: ["tabs"],
      workflows: [],
    });
    expect(executableSource(config, "todo")?.module).toBe(".work/todos.ts");
    expect(executableSource(config, "kids")).toBeUndefined();
  });
});

describe("workspace shape", () => {
  it("writes a first-run template that loads as the built-in layout", () => {
    const dir = makeDir();
    const file = path.join(dir, "workspace.js");
    fs.writeFileSync(file, DEFAULT_WORKSPACE_FILE);
    expect(loadWorkspaceConfigFile(file)).toEqual(DEFAULT_WORKSPACE_CONFIG);
  });

  it("starts with an empty right sidebar and tabs, not chats, on the left", () => {
    const left = DEFAULT_WORKSPACE_CONFIG.sidebars.left.flatMap(
      (tab) => tab.sections,
    );
    expect(DEFAULT_WORKSPACE_CONFIG.sidebars.right).toEqual([]);
    expect(left.some((section) => section.source === "work:chats")).toBe(false);
    expect(
      left.find((section) => section.source === "work:tabs"),
    ).toMatchObject({
      when: { tabPlacement: "sidebar" },
      headerActions: [{ url: "command:new-tab" }],
    });
    for (const section of left) expect(section).not.toHaveProperty("type");
  });

  it("requires sidebars and rejects unknown top-level keys", () => {
    expect(resolveProfile("module.exports = {}").error).toContain("sidebars");
    expect(
      resolveProfile(
        "module.exports = { sidebars: { left: [], right: [] }, extra: 1 }",
      ).error,
    ).toContain("Unknown workspace keys");
  });
});

describe("chips", () => {
  /** A profile layout with no sidebar sections and these chips. */
  const withChips = (chips: string) =>
    `module.exports = { sidebars: { left: [], right: [] }, chips: ${chips} };`;

  it("defaults to Work's chips, which run no module", () => {
    expect(DEFAULT_WORKSPACE_CONFIG.chips).toEqual({ source: "work:chips" });
    expect(chipsModule(DEFAULT_WORKSPACE_CONFIG)).toBeUndefined();
    expect(executableSource(DEFAULT_WORKSPACE_CONFIG, "chips")).toBeUndefined();
  });

  it("runs a module with the chat's chips and its workflows", () => {
    const { config, error } = resolveProfile(
      withChips(
        `{ source: ".work/chips.ts", collections: ["chips"], workflows: ["deploy"] }`,
      ),
    );
    expect(error).toBeUndefined();
    expect(chipsModule(config)).toBe(".work/chips.ts");
    expect(executableSource(config, "chips")).toEqual({
      module: ".work/chips.ts",
      collections: ["chips"],
      workflows: ["deploy"],
    });
    // No collections (or none named) grants nothing to read.
    const bare = resolveProfile(
      withChips(`{ source: ".work/chips.ts", collections: [] }`),
    ).config;
    expect(bare.chips).toEqual({ source: ".work/chips.ts" });
    expect(executableSource(bare, "chips")?.collections).toEqual([]);
  });

  it("refuses chips Work cannot run", () => {
    for (const [chips, message] of [
      [`"work:chips"`, "chips must be"],
      [`{ source: ".work/chips.ts", rank: 1 }`, "unknown keys rank"],
      [
        `{ source: "work:chips", workflows: ["deploy"] }`,
        "only a chips module",
      ],
      [`{ source: "work:git" }`, "not chips"],
      [`{ source: "work:nope" }`, "not one of Work's lists"],
      [`{ source: ".work/chips.ts", collections: ["tabs"] }`, "chips only"],
    ] as const)
      expect(resolveProfile(withChips(chips)).error, chips).toContain(message);
  });

  it("keeps the id chips for the chips' source", () => {
    expect(
      resolveProfile(sections(`{ id: "chips", title: "Chips", items: [] }`))
        .error,
    ).toContain('cannot take the id "chips"');
    expect(
      resolveProfile(
        `module.exports = { sidebars: { left: [], right: [] }, palette: { modes: [{ id: "chips", trigger: "chips", title: "Chips", source: "work:git" }] } };`,
      ).error,
    ).toContain('cannot take the id "chips"');
  });
});

describe("module rows", () => {
  it("keeps every row field and leaves out a record too large to cross", () => {
    const page = sanitizeSidebarSourcePage({
      items: [
        {
          id: "a",
          label: "A",
          url: "workflow:deploy",
          icon: "rocket:blue",
          signal: "working",
          badges: ["Draft", { label: "main", icon: "GitBranch" }],
          collapsed: false,
          data: { count: 1 },
        },
        { id: "b", label: "B", data: { blob: "x".repeat(140_000) } },
      ],
      cursor: "next",
    });
    expect(page.cursor).toBe("next");
    expect(page.items[0]).toMatchObject({
      url: "workflow:deploy",
      icon: "rocket:blue",
      signal: "working",
      badges: ["Draft", { label: "main", icon: "GitBranch" }],
      collapsed: false,
      data: { count: 1 },
    });
    expect(page.items[1]).not.toHaveProperty("data");
    expect(() =>
      sanitizeSidebarSourcePage({
        items: [
          { id: "a", label: "A" },
          { id: "a", label: "again" },
        ],
      }),
    ).toThrow("unique");
  });

  it("draws a chip's tone and width, and gives Work's verbs their looks", () => {
    const [chip] = sanitizeSidebarSourcePage({
      items: [
        {
          id: "deploy",
          label: "Deploy",
          wide: true,
          tone: "success",
          badges: [
            { label: "live", tone: "success" },
            { label: "odd", tone: "plaid" },
          ],
          actions: [
            { action: "open-side" },
            { action: "remove", label: "Remove", icon: "X" },
          ],
        },
      ],
    }).items;
    expect(chip).toMatchObject({
      wide: true,
      tone: "success",
      badges: [{ label: "live", tone: "success" }, { label: "odd" }],
      actions: [
        { action: "open-side", label: "Open to the side", icon: "Columns2" },
        { action: "remove", label: "Remove", icon: "X" },
      ],
    });
    expect(chip?.badges?.[1]).not.toHaveProperty("tone");
    const plain = sanitizeSidebarSourcePage({
      items: [{ id: "b", label: "B", tone: "plaid", wide: "yes" }],
    }).items[0];
    expect(plain).not.toHaveProperty("tone");
    expect(plain).not.toHaveProperty("wide");
    expect(() =>
      sanitizeSidebarSourcePage({
        items: [{ id: "a", label: "A", actions: [{ action: "deploy" }] }],
      }),
    ).toThrow("needs a label");
  });
});
