import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { customizationAuthoring } from "./customization-authoring.js";
import {
  checkCustomization,
  previewCustomization,
} from "./customization-check.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "work-authoring-test-")),
  );
  roots.push(root);
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".work/todos"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { check: "touch SCRIPT_EXECUTED" } }),
  );
  const assets = path.resolve(
    import.meta.dirname,
    "../../out/main/authoring-assets.json",
  );
  const authoring = customizationAuthoring({
    cacheDirectory: path.join(root, "sdk"),
    assetsFile: assets,
  });
  const sourcePath = ".work/todos/index.ts";
  fs.writeFileSync(
    path.join(project, sourcePath),
    `import type {SidebarSourceModule} from '@catamorphic/work-customization';
export default {load:async()=>({items:[{id:'one',label:'Review',description:'Extra detail',descriptionVisibility:'hover'}]})} satisfies SidebarSourceModule;`,
  );
  return { root, project, sourcePath, authoring };
}
it("checks hidden source roots against installed declarations without running project scripts", async () => {
  const { project, sourcePath, authoring } = fixture();
  const input = {
    projectRoot: project,
    sourcePath,
    sdkRoot: authoring.sdkRoot,
  };
  expect(await checkCustomization(input)).toMatchObject({
    ok: true,
    diagnostics: [],
  });
  expect(fs.existsSync(path.join(project, "SCRIPT_EXECUTED"))).toBe(false);
  fs.appendFileSync(
    path.join(project, sourcePath),
    '\nconst invalid: number = "text";',
  );
  const checked = await checkCustomization(input);
  expect(checked.ok).toBe(false);
  expect(
    checked.diagnostics.some(
      (diagnostic) =>
        diagnostic.file?.endsWith(sourcePath) && diagnostic.code === "TS2322",
    ),
  ).toBe(true);
});
it("rejects unsupported runtime layout fields even when JavaScript can parse them", async () => {
  const { project, authoring } = fixture();
  fs.writeFileSync(
    path.join(project, "workspace.js"),
    `module.exports={sidebars:{left:[{id:'main',title:'Main',sections:[{id:'todos',title:'Todos',source:{module:'.work/todos/index.ts'},contextMenu:[]}]}],right:[]}};`,
  );
  const checked = await checkCustomization({
    projectRoot: project,
    workspacePath: "workspace.js",
    sdkRoot: authoring.sdkRoot,
  });
  expect(checked.ok).toBe(false);
  expect(
    checked.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("itemDefaults"),
    ),
  ).toBe(true);
});
it("checks the shipped source and layout reference examples", async () => {
  const { project, authoring, sourcePath } = fixture();
  const reference = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../docs/customization-reference.md"),
    "utf8",
  );
  const source = /```ts\n([\s\S]*?)\n```/.exec(reference)?.[1];
  const layout = /```js\n([\s\S]*?)\n```/.exec(reference)?.[1];
  if (!source || !layout)
    throw new Error("Missing complete reference examples");
  fs.writeFileSync(path.join(project, sourcePath), source);
  fs.writeFileSync(path.join(project, "workspace.js"), layout);
  expect(
    await checkCustomization({
      projectRoot: project,
      sourcePath,
      workspacePath: "workspace.js",
      sdkRoot: authoring.sdkRoot,
    }),
  ).toMatchObject({ ok: true, diagnostics: [] });
});
it.skipIf(process.platform !== "darwin")(
  "previews the installed self-contained worker through real confinement",
  async () => {
    const { root, project, sourcePath, authoring } = fixture();
    const preview = await previewCustomization({
      projectRoot: project,
      sourcePath,
      workerPath: authoring.worker,
      scratchRoot: path.join(root, "scratch"),
      toolchain: { PATH: process.env.PATH ?? "" },
    });
    expect(preview).toMatchObject({
      ok: true,
      result: { items: [{ id: "one", descriptionVisibility: "hover" }] },
    });
    fs.writeFileSync(
      path.join(project, ".work/todos/package.json"),
      JSON.stringify({ catamorphic: { access: { permissions: ["state"] } } }),
    );
    expect(
      await previewCustomization({
        projectRoot: project,
        sourcePath,
        workerPath: authoring.worker,
        scratchRoot: path.join(root, "scratch"),
        toolchain: {},
      }),
    ).toMatchObject({ ok: false, accessRequired: { permissions: ["state"] } });
  },
);

it.skipIf(process.platform !== "darwin")(
  "uses the live app-composition grant for load and reveal previews",
  async () => {
    const { root, project, sourcePath, authoring } = fixture();
    fs.writeFileSync(
      path.join(project, sourcePath),
      `const row={id:'one',label:'Task',preview:{content:{app:'details'}}};export default {load:async()=>({items:[row]}),reveal:async()=>row};`,
    );
    const input = {
      projectRoot: project,
      sourcePath,
      workerPath: authoring.worker,
      scratchRoot: path.join(root, "scratch"),
      toolchain: { PATH: process.env.PATH ?? "" },
    };
    expect(await previewCustomization(input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("catamorphic.access.lists"),
    });
    fs.writeFileSync(
      path.join(project, ".work/todos/package.json"),
      JSON.stringify({ catamorphic: { access: { lists: ["apps"] } } }),
    );
    const approvedAccess = { lists: ["apps"] };
    expect(
      await previewCustomization({ ...input, approvedAccess }),
    ).toMatchObject({
      ok: true,
      result: { items: [{ preview: { content: { app: "details" } } }] },
    });
    expect(
      await previewCustomization({
        ...input,
        approvedAccess,
        request: { method: "reveal", url: "app:details" },
      }),
    ).toMatchObject({
      ok: true,
      result: { preview: { content: { app: "details" } } },
    });
  },
);
