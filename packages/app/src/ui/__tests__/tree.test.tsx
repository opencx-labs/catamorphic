import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type CollectionPage, createCollection } from "../../collection.js";
import { CollectionItemView } from "../collection-item.js";
import { CollectionTree, Tree } from "../tree.js";

describe("public collection presentation", () => {
  it("resumes an expanded child request after the view becomes active again", async () => {
    type Item = { id: string; parentId?: string | null; hasChildren?: boolean };
    const children: {
      signal: AbortSignal;
      resolve: (page: CollectionPage<Item>) => void;
    }[] = [];
    const collection = createCollection<Item>({
      source: {
        load: async ({ parentId, signal }) =>
          parentId
            ? new Promise((resolve) => children.push({ signal, resolve }))
            : { items: [{ id: "parent", hasChildren: true }] },
      },
    });
    const view = (active: boolean) => (
      <CollectionTree
        collection={collection}
        active={active}
        label="Resuming tree"
        renderItem={(item, context) => (
          <button type="button" onClick={context.toggle}>
            {item.id}
          </button>
        )}
      />
    );
    const mounted = render(view(true));
    fireEvent.click(await screen.findByRole("button", { name: "parent" }));
    expect(children).toHaveLength(1);
    mounted.rerender(view(false));
    await waitFor(() => expect(children[0]?.signal.aborted).toBe(true));
    mounted.rerender(view(true));
    await waitFor(() => expect(children).toHaveLength(2));
    children[1]?.resolve({ items: [{ id: "child", parentId: "parent" }] });
    expect(await screen.findByRole("button", { name: "child" })).toBeTruthy();
    mounted.unmount();
  });
  it("bounds DOM size for a 10,000-item hierarchy", () => {
    const items = Array.from({ length: 10000 }, (_, index) => ({
      id: String(index),
      parentId: index ? "0" : null,
    }));
    render(
      <Tree
        items={items}
        label="Large tree"
        height={280}
        renderItem={(item) => <button type="button">{item.id}</button>}
      />,
    );
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(20);
    fireEvent.keyDown(screen.getAllByRole("treeitem")[0], { key: "End" });
    expect(screen.getAllByRole("treeitem").length).toBeLessThanOrEqual(20);
  });
  it("keeps disclosure by ID through reordering and lazily requests children", () => {
    const load = vi.fn();
    const renderItem = (
      item: { id: string },
      context: { expanded: boolean; toggle: () => void },
    ) => (
      <button type="button" onClick={context.toggle}>
        {item.id}
        {context.expanded ? " open" : " closed"}
      </button>
    );
    const { rerender } = render(
      <Tree
        items={[{ id: "parent", hasChildren: true }, { id: "sibling" }]}
        label="Tree"
        defaultExpanded={false}
        loadChildren={load}
        renderItem={renderItem}
      />,
    );
    fireEvent.click(screen.getByText("parent closed"));
    expect(load).toHaveBeenCalledWith("parent");
    rerender(
      <Tree
        items={[
          { id: "sibling" },
          { id: "parent", hasChildren: true },
          { id: "child", parentId: "parent" },
        ]}
        label="Tree"
        defaultExpanded={false}
        loadChildren={load}
        renderItem={renderItem}
      />,
    );
    expect(screen.getByText("parent open")).toBeTruthy();
    expect(screen.getByText("child closed")).toBeTruthy();
  });
  it("distinguishes overflow, right-click and inline actions", async () => {
    const inline = vi.fn();
    const overflow = vi.fn();
    const context = vi.fn();
    const { container } = render(
      <CollectionItemView
        id="item"
        label="Item"
        actions={[{ id: "inline", label: "Inline", run: inline }]}
        menu={[{ id: "overflow", label: "Overflow", run: overflow }]}
        contextMenu={[{ id: "context", label: "Context", run: context }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inline" }));
    await waitFor(() => expect(inline).toHaveBeenCalledTimes(1));
    fireEvent.contextMenu(container.firstElementChild!);
    expect(screen.getByRole("menuitem", { name: "Context" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Overflow" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Context" }));
    await waitFor(() => expect(context).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Item" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Overflow" }));
    await waitFor(() => expect(overflow).toHaveBeenCalledTimes(1));
  });
  it("keeps inspectors outside virtual row geometry and restores focus on Escape", () => {
    const { container } = render(
      <CollectionItemView
        id="inspect"
        label="Inspectable"
        preview={<p>Rich details</p>}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect Inspectable" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Inspectable details" });
    expect(container.contains(dialog)).toBe(false);
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Inspectable" }),
    );
  });
  it("does not reclaim keyboard focus after unrelated collection updates", () => {
    const first = [{ id: "one" }, { id: "two" }];
    const row = (item: { id: string }) => (
      <button type="button">{item.id}</button>
    );
    const { rerender } = render(
      <>
        <input aria-label="Editor" />
        <Tree items={first} label="Navigation" renderItem={row} />
      </>,
    );
    fireEvent.keyDown(screen.getAllByRole("treeitem")[0], { key: "End" });
    screen.getByRole("textbox").focus();
    rerender(
      <>
        <input aria-label="Editor" />
        <Tree
          items={[...first, { id: "three" }]}
          label="Navigation"
          renderItem={row}
        />
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });
});
