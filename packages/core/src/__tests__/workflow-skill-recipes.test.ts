import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseProject } from "@catamorphic/parser";
import { expect, it } from "vitest";
import { SEED_SKILLS } from "../seeds.js";

const skills = ["writing-workflows", "durable-workflows", "batch-workflows"];
const sources = skills.map((skill) => {
  const text = SEED_SKILLS[`.catamorphic/skills/${skill}/SKILL.md`];
  const source = text && /```typescript\n([\s\S]*?)```/.exec(text)?.[1];
  if (!source) throw new Error(`Missing ${skill} recipe`);
  return { name: skill, source };
});

it("the shipped authoring recipes parse as ordinary workflows", () => {
  const result = parseProject(
    Object.fromEntries(
      sources.map(({ name, source }) => [
        `.catamorphic/workflows/src/${name}.ts`,
        source,
      ]),
    ),
  );
  expect(result.errors).toEqual([]);
  expect(
    result.workflows.map((workflow) => workflow.functionName).sort(),
  ).toEqual([
    "approveOrder",
    "finishOrder",
    "prepareGreeting",
    "processRecords",
  ]);
});

async function execute(script: string): Promise<unknown> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "workflow-recipes-"),
  );
  try {
    for (const { name, source } of sources) {
      await fs.writeFile(
        path.join(directory, `${name}.ts`),
        source.replace(
          '"@catamorphic/workflow"',
          JSON.stringify(
            path.resolve(import.meta.dirname, "../../../workflow/src/index.ts"),
          ),
        ),
      );
    }
    await fs.writeFile(path.join(directory, "verify.ts"), script);
    const result = await promisify(execFile)("bun", ["run", "verify.ts"], {
      cwd: directory,
      timeout: 10000,
    });
    return JSON.parse(result.stdout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

it("the basic recipe produces its advertised result", async () => {
  expect(
    await execute(`
    import { prepareGreeting } from "./writing-workflows.ts";
    console.log(JSON.stringify(await prepareGreeting.steps[0].run({ input: { name: " Ada " } })));
  `),
  ).toEqual({ message: "Hello, Ada!" });
});

it("approval carries state and invokes its child only on explicit approval", async () => {
  expect(
    await execute(`
    import { approveOrder, finishOrder } from "./durable-workflows.ts";
    const state = { orderId: "order-1", requestId: "approval-1" };
    const pause = options => ({ operation: "pause", ...options });
    const callWorkflow = (child, args) => ({ operation: "child", correctChild: child === finishOrder, ...args });
    const decide = input => approveOrder.steps[1].run({ input, callWorkflow });
    console.log(JSON.stringify([
      await approveOrder.steps[0].run({ input: state, pause }),
      await decide({ reason: "timed_out", state }),
      await decide({ reason: "resumed", state, value: { approved: false } }),
      await decide({ reason: "resumed", state, value: { approved: true } }),
    ]));
  `),
  ).toEqual([
    {
      operation: "pause",
      timeout: "24h",
      state: { orderId: "order-1", requestId: "approval-1" },
    },
    { orderId: "order-1", status: "timed_out" },
    { orderId: "order-1", status: "rejected" },
    {
      operation: "child",
      correctChild: true,
      input: { orderId: "order-1", requestId: "approval-1" },
    },
  ]);
});

it("the paged recipe replays pages, terminates, and preserves physical outcome keys", async () => {
  expect(
    await execute(`
    import { recordsSource, normalizeRecords, processRecords } from "./batch-workflows.ts";
    const records = [{ id: "a", value: " Alpha " }, { id: "b", value: " " }, { id: "c", value: " Charlie " }];
    const initial = await recordsSource.initialize({ config: { records } });
    const pageArgs = { snapshot: initial.snapshot, cursor: initial.cursor, limit: 2 };
    const first = await recordsSource.readPage(pageArgs);
    const replay = await recordsSource.readPage(pageArgs);
    const last = await recordsSource.readPage({ ...pageArgs, cursor: first.nextCursor });
    const empty = await recordsSource.readPage({ snapshot: { records: [] }, limit: 2 });
    const outcomes = await normalizeRecords.run({ items: [records[2], records[0]].map(record => ({ key: record.id, value: { record } })) });
    let skip;
    try { await processRecords.steps[0].process({ key: "b", item: records[1] }); } catch (error) { skip = error.reason; }
    console.log(JSON.stringify({ first, replay, last, empty, outcomes, skip }));
  `),
  ).toEqual({
    first: {
      items: [
        { key: "a", value: { id: "a", value: " Alpha " } },
        { key: "b", value: { id: "b", value: " " } },
      ],
      nextCursor: 2,
      done: false,
    },
    replay: {
      items: [
        { key: "a", value: { id: "a", value: " Alpha " } },
        { key: "b", value: { id: "b", value: " " } },
      ],
      nextCursor: 2,
      done: false,
    },
    last: {
      items: [{ key: "c", value: { id: "c", value: " Charlie " } }],
      nextCursor: 3,
      done: true,
    },
    empty: { items: [], nextCursor: 0, done: true },
    outcomes: [
      { key: "c", status: "succeeded", result: { value: "Charlie" } },
      { key: "a", status: "succeeded", result: { value: "Alpha" } },
    ],
    skip: "Record value is empty",
  });
});
