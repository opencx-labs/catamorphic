import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceStateStore } from "./workspace-state.js";

/** The first half of an emoji's surrogate pair, as a cut leaves it. */
const HALF_EMOJI = "🚀".slice(0, 1);

let database: PGlite;
let store: WorkspaceStateStore;

beforeEach(async () => {
  database = new PGlite();
  store = new WorkspaceStateStore(database);
  await store.init();
});

afterEach(async () => {
  await database.close();
});

it("saves tabs whose titles a page cut through an emoji or that carry a NUL", async () => {
  const projectId = randomUUID();
  // Each save replaces the last: an earlier one must not be what a
  // relaunch restores.
  await store.set(projectId, { tabs: [{ title: "Earlier" }] });
  await store.set(projectId, {
    tabs: [
      { kind: "web", title: `Launch day ${HALF_EMOJI}` },
      { kind: "web", title: "Report\u0000 draft" },
    ],
    history: [{ title: `${"🚀".slice(1)} landing` }],
  });
  expect(await store.get(projectId)).toEqual({
    tabs: [
      { kind: "web", title: "Launch day \uFFFD" },
      { kind: "web", title: "Report\uFFFD draft" },
    ],
    history: [{ title: "\uFFFD landing" }],
  });
});

it("keeps whole emoji, and text that only reads like an escape, as they are", async () => {
  const projectId = randomUUID();
  const state = {
    tabs: [{ title: 'Ship it 🚀 "now" in C:\\u0000\\ \u00e9' }],
  };
  await store.set(projectId, state);
  expect(await store.get(projectId)).toEqual(state);
});
