import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkCustomization } from "../../apps/desktop/src/main/customization-check.js";
import {
  canonicalModuleAccess,
  readModuleAccess,
} from "../../apps/desktop/src/main/module-access.js";
import { launchConfinedModule } from "../../apps/desktop/src/main/module-sandbox.js";
import { SidebarSourceRuntime } from "../../apps/desktop/src/main/sidebar-source-runtime.js";
import { loadWorkspaceConfigFile } from "../../apps/desktop/src/main/workspace-config.js";
import type { SidebarMenuEntry } from "../../apps/desktop/src/shared/sidebar.js";
import type {
  SidebarSourceItem,
  SidebarSourceRequest,
} from "../../apps/desktop/src/shared/sidebar-source.js";
import { sidebarSourceEffect } from "../../apps/desktop/src/shared/sidebar-source.js";
import { sanitizeSidebarSourcePage } from "../../apps/desktop/src/shared/source-rows.js";
import type { EvalFixture } from "./fixture.js";
import { TODO_SEED } from "./scenarios.js";

export interface Grade {
  id: string;
  passed: boolean;
  detail: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Treat evaluator addresses as untrusted generated input too. */
export async function projectFile(input: {
  project: string;
  relative: unknown;
}): Promise<string> {
  if (typeof input.relative !== "string" || path.isAbsolute(input.relative))
    throw new Error("Result address must be a project-relative file");
  const [root, file] = await Promise.all([
    realpath(input.project),
    realpath(path.resolve(input.project, input.relative)),
  ]);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Result address leaves the disposable project");
  return file;
}

/** Preview and grading both start the production source worker in real confinement. */
export function evalSourceAccess(input: {
  project: string;
  modulePath: string;
}) {
  const access = canonicalModuleAccess({
    projectRoot: input.project,
    access: readModuleAccess({
      modulePath: input.modulePath,
      projectRoot: input.project,
    }).access,
  });
  for (const destination of [
    ...(access.reads ?? []),
    ...(access.writes ?? []),
  ]) {
    const relative = path.relative(input.project, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Eval sources may reach only their disposable project");
  }
  if (access.hosts?.length)
    throw new Error(
      "This offline sidebar scenario grants no external network hosts",
    );
  return access;
}

export function createEvalSourceRuntime(input: {
  project: string;
  modulePath: string;
  directory: string;
  repository: string;
  sourceWork?: EvalFixture["sourceWork"];
}): SidebarSourceRuntime {
  const access = evalSourceAccess(input);
  const workerPath = path.join(
    input.directory,
    "profile/runtime/sidebar-source-worker.mjs",
  );
  return new SidebarSourceRuntime({
    modulePath: input.modulePath,
    projectRoot: input.project,
    work: input.sourceWork?.({ modulePath: input.modulePath }),
    launch: () =>
      launchConfinedModule({
        executable: process.execPath,
        workerPath,
        modulePath: input.modulePath,
        projectRoot: input.project,
        access,
        toolchain: { PATH: process.env.PATH ?? "" },
        scratchRoot: path.join(input.directory, "profile", "modules"),
        scope: "eval-owner",
      }),
    timeoutMs: 10_000,
  });
}

export async function gradeTodo(input: {
  project: string;
  directory: string;
  repository: string;
  sourceWork?: EvalFixture["sourceWork"];
}): Promise<Grade[]> {
  const grades: Grade[] = [];
  const check = async (id: string, test: () => string | Promise<string>) => {
    try {
      grades.push({ id, passed: true, detail: await test() });
    } catch (error) {
      grades.push({
        id,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const entry: unknown = JSON.parse(
    await readFile(path.join(input.project, "eval-entry.json"), "utf8"),
  );
  if (!record(entry)) throw new Error("eval-entry.json must be an object");
  const modulePath = await projectFile({
    project: input.project,
    relative: entry.source,
  });
  const layout = await projectFile({
    project: input.project,
    relative: entry.layout,
  });
  await check("installed-sdk-typecheck", async () => {
    const result = await checkCustomization({
      projectRoot: input.project,
      sourcePath: modulePath,
      workspacePath: layout,
      sdkRoot: input.project,
      bunPath: process.execPath,
    });
    await writeFile(
      path.join(input.directory, "typecheck.json"),
      JSON.stringify(result, null, 2),
    );
    assert(
      result.ok,
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
    return "Work's installed SDK checker accepts the source and runtime layout";
  });
  await check("typed-layout", async () => {
    const config = loadWorkspaceConfigFile(layout);
    const sections = [
      ...config.sidebars.left,
      ...config.sidebars.right,
    ].flatMap((tab) => tab.sections);
    assert(
      sections.some(
        (section) =>
          typeof section.source === "string" &&
          path.resolve(input.project, section.source) === modulePath,
      ),
      "Work's real layout loader did not produce a section pointing at the generated source",
    );
    return path.relative(input.project, layout);
  });
  const createRuntime = () => createEvalSourceRuntime({ ...input, modulePath });
  let runtime = createRuntime();
  const request = (
    body: Omit<SidebarSourceRequest, "projectId" | "sectionId" | "requestId">,
  ) =>
    runtime.request({
      projectId: "eval-project",
      sectionId: "todos",
      requestId: crypto.randomUUID(),
      ...body,
    });
  const load = async () =>
    sanitizeSidebarSourcePage(await request({ method: "load", parentId: null }))
      .items;
  let rows: SidebarSourceItem[] = [];
  const row = (id: string) => {
    const found = rows.find((entry) => entry.id === id);
    if (!found) throw new Error(`Row ${id} is missing`);
    return found;
  };
  const actions = (item: SidebarSourceItem): SidebarMenuEntry[] => [
    ...(item.menu ?? []),
    ...(item.contextMenu ?? []),
    ...(item.actions ?? []),
  ];
  try {
    await check("confined-rows", async () => {
      rows = await load();
      assert(
        rows.length === TODO_SEED.length,
        `Expected exactly three compact rows, got ${rows.length}`,
      );
      for (const todo of TODO_SEED)
        assert(
          rows.some((entry) => entry.label === todo.label),
          `Missing full title: ${todo.label}`,
        );
      return "All three todos load as one row each inside real OS confinement";
    });
    await writeFile(
      path.join(input.directory, "preview.json"),
      `${JSON.stringify({ items: rows }, null, 2)}\n`,
    );
    await check("hover-details", () => {
      for (const todo of TODO_SEED) {
        const item = rows.find((entry) => entry.label === todo.label);
        const preview = JSON.stringify(item?.preview);
        assert(
          preview?.includes(todo.label) && preview.includes(todo.notes),
          `Hover omits the title or notes for ${todo.label}`,
        );
        assert(
          item?.preview &&
            typeof item.preview === "object" &&
            Boolean(item.preview.metadata?.length),
          `Hover has no due-date metadata for ${todo.label}`,
        );
      }
      return "Hover previews expose full names, notes, and due metadata";
    });
    await check("normal-click-and-open-modes", async () => {
      const item = rows.find((entry) => entry.label === TODO_SEED[0]?.label);
      if (!item) throw new Error("First todo missing");
      const expected = TODO_SEED[0]?.url;
      if (item.url) {
        assert(
          item.url === expected,
          `Row opens ${item.url}, expected ${expected}`,
        );
        return "Declarative row target uses Work's shared here/tab/side/floating resolver";
      }
      for (const mode of ["replace", "tab", "side", "floating"] as const) {
        const effect = sidebarSourceEffect(
          await request({
            method: "action",
            itemId: item.id,
            action: "open",
            mode,
          }),
        );
        assert(
          effect?.open === expected && effect?.mode === mode,
          `Opening in ${mode} lost its target or mode`,
        );
      }
      return "Canonical open action preserves all four modes";
    });
    const first = rows[0];
    const last = rows.at(-1);
    await check("reorder", async () => {
      if (!first || !last) throw new Error("Rows missing");
      assert(runtime.capabilities.move, "Source does not support move");
      await request({
        method: "move",
        itemId: last.id,
        parentId: null,
        beforeId: first.id,
      });
      rows = await load();
      assert(
        rows[0]?.id === last.id,
        "Dragged row did not move before the first row",
      );
      return "Reorder keeps row identity and changes the visible order";
    });
    const renameId = first?.id;
    await check("rename", async () => {
      if (!renameId) throw new Error("First row missing");
      const action = actions(row(renameId)).find((entry) =>
        /rename/i.test(entry.label),
      );
      const field = action?.input?.fields[0]?.name;
      if (!action || !field)
        throw new Error("Rename has no declarative input action");
      await request({
        method: "action",
        itemId: renameId,
        action: action.action,
        values: { [field]: "Renamed launch plan" },
      });
      rows = await load();
      assert(
        row(renameId).label === "Renamed launch plan",
        "Rename did not change the row label",
      );
      return "Rename uses the row's actual menu and input field";
    });
    const doneId = last?.id;
    await check("done", async () => {
      if (!doneId) throw new Error("Last row missing");
      const action = actions(row(doneId)).find((entry) =>
        /\b(done|complete|finish)\b/i.test(entry.label),
      );
      if (!action) throw new Error("No Done action is offered on the todo");
      await request({
        method: "action",
        itemId: doneId,
        action: action.action,
      });
      rows = await load();
      assert(
        !rows.some((item) => item.id === doneId),
        "Completed todo remains in the active list",
      );
      return "Done removes the selected todo from active rows";
    });
    await check("restart-persistence", async () => {
      const before = rows.map((item) => ({ id: item.id, label: item.label }));
      runtime.dispose();
      runtime = createRuntime();
      rows = await load();
      assert(
        JSON.stringify(
          rows.map((item) => ({ id: item.id, label: item.label })),
        ) === JSON.stringify(before),
        "Rows changed after a fresh source process started",
      );
      assert(
        renameId && row(renameId).label === "Renamed launch plan",
        "Renamed state did not survive",
      );
      assert(
        doneId && !rows.some((item) => item.id === doneId),
        "Completed state did not survive",
      );
      return "A new confined process preserves the user's edits";
    });
  } finally {
    runtime.dispose();
  }
  return grades;
}
