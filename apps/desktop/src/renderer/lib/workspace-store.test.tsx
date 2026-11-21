// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { emptyWorkspace, type Workspace } from "./workspace-state.js";
import {
  allWorkspaces,
  createWorkspaceStore,
  useWorkspaces,
  type WorkspaceStore,
} from "./workspace-store.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

const withFront = (workspace: Workspace, key: string): Workspace => ({
  ...workspace,
  activeTabKey: key,
});

it("applies a change at once and tells nothing when nothing changed", () => {
  const store = createWorkspaceStore();
  let told = 0;
  const stop = store.subscribe(() => {
    told += 1;
  });
  const workspace = emptyWorkspace();
  store.update((current) => ({ ...current, project: workspace }));
  expect(store.get().project).toBe(workspace);
  expect(told).toBe(1);
  store.update((current) => current);
  expect(told).toBe(1);
  stop();
  store.update(() => ({}));
  expect(told).toBe(1);
});

it("renders a follower only when the slice it shows changes", () => {
  const store = createWorkspaceStore();
  store.update(() => ({ project: emptyWorkspace(), other: emptyWorkspace() }));
  const renders = { all: 0, front: 0 };
  function All() {
    renders.all += 1;
    return <i>{Object.keys(useWorkspaces(store, allWorkspaces)).length}</i>;
  }
  function Front({ id }: { id: string }) {
    renders.front += 1;
    return (
      <b>
        {useWorkspaces(store, (all) => all[id]?.activeTabKey ?? "none", [id])}
      </b>
    );
  }
  act(() =>
    root.render(
      <>
        <All />
        <Front id="project" />
      </>,
    ),
  );
  expect(renders).toEqual({ all: 1, front: 1 });
  // Another project's tab comes to the front: only the root follows it.
  act(() =>
    store.update((all) => ({
      ...all,
      other: withFront(all.other ?? emptyWorkspace(), "history:history"),
    })),
  );
  expect(renders).toEqual({ all: 2, front: 1 });
  act(() =>
    store.update((all) => ({
      ...all,
      project: withFront(all.project ?? emptyWorkspace(), "sites:sites"),
    })),
  );
  expect(renders).toEqual({ all: 3, front: 2 });
  expect(node.querySelector("b")?.textContent).toBe("sites:sites");
});

it("follows another slice when its inputs change", () => {
  const store = createWorkspaceStore();
  store.update(() => ({
    one: withFront(emptyWorkspace(), "history:history"),
    two: withFront(emptyWorkspace(), "sites:sites"),
  }));
  function Front({ id }: { id: string }) {
    return <b>{useWorkspaces(store, (all) => all[id]?.activeTabKey, [id])}</b>;
  }
  act(() => root.render(<Front id="one" />));
  expect(node.textContent).toBe("history:history");
  act(() => root.render(<Front id="two" />));
  expect(node.textContent).toBe("sites:sites");
});

it("commits a workspace change and a state change made beside it together", () => {
  const store: WorkspaceStore = createWorkspaceStore();
  store.update(() => ({ project: withFront(emptyWorkspace(), "none") }));
  const seen: string[] = [];
  let change = () => {};
  function Window() {
    const [dialog, setDialog] = useState("closed");
    const front = useWorkspaces(
      store,
      (all) => all.project?.activeTabKey ?? "none",
    );
    seen.push(`${front} ${dialog}`);
    change = () => {
      store.update((all) => ({
        ...all,
        project: withFront(all.project ?? emptyWorkspace(), "sites:sites"),
      }));
      setDialog("open");
    };
    return null;
  }
  act(() => root.render(<Window />));
  act(() => change());
  // Never the new tab beside the old dialog state, or the reverse.
  expect(seen).toEqual(["none closed", "sites:sites open"]);
});
