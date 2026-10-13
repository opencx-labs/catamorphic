import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

it("reorders loaded siblings when a sort field changes across pages", async () => {
  let title = "D";
  const collection = createCollection({
    source: {
      load: async ({ cursor }) =>
        cursor
          ? {
              items: [
                { id: "c", title: "C" },
                { id: "d", title: "E" },
              ],
            }
          : {
              items: [
                { id: "a", title: "A" },
                { id: "b", title },
              ],
              cursor: "2",
            },
    },
  });
  render(
    <CollectionTree
      collection={collection}
      label="Sorted"
      project={(items) =>
        [...items].sort((a, b) => a.title.localeCompare(b.title))
      }
      renderItem={(item) => <span>{item.title}</span>}
    />,
  );
  await screen.findByText("A");
  await act(() => collection.load({ more: true }));
  const labels = () =>
    screen.getAllByRole("treeitem").map((row) => row.textContent);
  await waitFor(() => expect(labels()).toEqual(["A", "C", "D", "E"]));
  title = "B";
  await act(() => collection.load());
  await waitFor(() => expect(labels()).toEqual(["A", "B", "C", "E"]));
});

it("releases descendants of a collapsed group and resumes them when reopened", async () => {
  const children: AbortSignal[] = [];
  const collection = createCollection<{
    id: string;
    hasChildren?: boolean;
    team: string;
  }>({
    source: {
      load: async ({ parentId, signal }) => {
        if (!parentId)
          return { items: [{ id: "parent", team: "Team", hasChildren: true }] };
        children.push(signal);
        return new Promise(() => {});
      },
    },
  });
  render(
    <CollectionTree
      collection={collection}
      label="Grouped"
      groupBy={(item) => item.team}
      renderItem={(item, context) => (
        <button type="button" onClick={context.toggle}>
          {item.id}
        </button>
      )}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Expand Team" }));
  const parent = await screen.findByRole("button", { name: "parent" });
  await act(async () => {
    fireEvent.click(parent);
  });
  expect(children).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Collapse Team" }));
  });
  expect(children[0]?.aborted).toBe(true);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Expand Team" }));
  });
  expect(children).toHaveLength(2);
});

describe("paged trees", () => {
  type Row = { id: string; label: string };
  /** `total` rows, `size` per page; each read waits for the test. */
  const pagedSource = (total: number, size: number) => {
    const reads: Array<{
      cursor?: string;
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];
    const load = vi.fn(
      ({ cursor }: { cursor?: string }) =>
        new Promise<CollectionPage<Row>>((resolve, reject) => {
          const offset = cursor ? Number(cursor) : 0;
          const next = offset + size;
          const page = {
            items: Array.from(
              { length: Math.max(0, Math.min(size, total - offset)) },
              (_, index) => ({
                id: `r${offset + index}`,
                label: `Row ${offset + index}`,
              }),
            ),
            cursor: next < total ? String(next) : undefined,
          };
          reads.push({ cursor, resolve: () => resolve(page), reject });
        }),
    );
    return { collection: createCollection<Row>({ source: { load } }), reads };
  };
  const view = (
    collection: ReturnType<typeof pagedSource>["collection"],
    active = true,
  ) => (
    <CollectionTree
      collection={collection}
      active={active}
      label="Chats"
      height={140}
      rowHeight={28}
      renderItem={(item) => <button type="button">{item.label}</button>}
    />
  );
  /** Placeholders holding the end, not ones fading out. */
  const placeholders = (container: HTMLElement) =>
    container.querySelectorAll(
      '[data-tree-more="placeholder"]:not(.cat-row-exit)',
    ).length;
  const scrollTo = (top: number) => {
    const tree = screen.getByRole("tree");
    tree.scrollTop = top;
    fireEvent.scroll(tree);
  };

  it("reads the next page as the person nears the end and says so", async () => {
    const { collection, reads } = pagedSource(25, 10);
    const { container } = render(view(collection));
    await act(async () => reads[0]?.resolve());
    expect(await screen.findByRole("button", { name: "Row 0" })).toBeTruthy();
    // The end waits as still placeholders, out of reach for now.
    expect(placeholders(container)).toBe(3);
    expect(reads).toHaveLength(1);
    // Within one viewport (five rows) of the end, the next page is read.
    await act(async () => scrollTo(56));
    expect(reads.map((read) => read.cursor)).toEqual([undefined, "10"]);
    expect(screen.getByRole("status").textContent).toBe(
      "Loading more in Chats",
    );
    expect(placeholders(container)).toBe(3);
    await act(async () => reads[1]?.resolve());
    expect(await screen.findByRole("button", { name: "Row 10" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("10 more in Chats");
    // New rows arrive with the list motion where the placeholders were,
    // which fade there; the end now waits below the new rows.
    expect(
      screen
        .getByRole("button", { name: "Row 10" })
        .closest('[role="treeitem"]')?.className,
    ).toBe("cat-row-enter");
    const tops = (selector: string) =>
      [...container.querySelectorAll<HTMLElement>(selector)].map(
        (element) => element.style.top,
      );
    expect(tops('[data-tree-more="placeholder"].cat-row-exit')).toEqual([
      "280px",
      "308px",
      "336px",
    ]);
    // The new end (row 20, 560px) is past the rendered rows.
    expect(tops('[data-tree-more="placeholder"]:not(.cat-row-exit)')).toEqual(
      [],
    );
    expect(screen.getByRole("tree").firstElementChild).toHaveProperty(
      "style.height",
      `${23 * 28}px`,
    );
    expect(reads).toHaveLength(2);
    await act(async () => scrollTo(28 * 18));
    expect(reads.map((read) => read.cursor)).toEqual([undefined, "10", "20"]);
    await act(async () => reads[2]?.resolve());
    await screen.findByRole("button", { name: "Row 24" });
    // The last page: the placeholders leave, fading where they stood.
    expect(placeholders(container)).toBe(0);
    expect(
      container.querySelectorAll('[data-tree-more="placeholder"].cat-row-exit')
        .length,
    ).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-tree-more="placeholder"]'),
      ).toHaveLength(0),
    );
    expect(reads).toHaveLength(3);
  });

  it("ends a branch with its error and Retry when a page fails", async () => {
    const { collection, reads } = pagedSource(15, 10);
    const { container } = render(view(collection));
    await act(async () => reads[0]?.resolve());
    await screen.findByRole("button", { name: "Row 0" });
    await act(async () => scrollTo(56));
    await act(async () => reads[1]?.reject(new Error("Offline")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Offline");
    expect(placeholders(container)).toBe(0);
    // A failed page is not read again on its own as the person scrolls.
    await act(async () => scrollTo(84));
    expect(reads).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reads.map((read) => read.cursor)).toEqual([undefined, "10", "10"]);
    await act(async () => reads[2]?.resolve());
    expect(await screen.findByRole("button", { name: "Row 14" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the next page when keyboard focus reaches the end", async () => {
    const { collection, reads } = pagedSource(25, 10);
    render(view(collection));
    await act(async () => reads[0]?.resolve());
    await screen.findByRole("button", { name: "Row 0" });
    expect(reads).toHaveLength(1);
    await act(async () => {
      fireEvent.keyDown(screen.getAllByRole("treeitem")[0] as HTMLElement, {
        key: "End",
      });
    });
    expect(reads.map((read) => read.cursor)).toEqual([undefined, "10"]);
  });

  it("reads nothing more while the view is hidden", async () => {
    const { collection, reads } = pagedSource(25, 10);
    const pending = collection.load();
    reads[0]?.resolve();
    await pending;
    const { container } = render(view(collection, false));
    await screen.findByRole("button", { name: "Row 0" });
    await act(async () => scrollTo(28 * 8));
    expect(placeholders(container)).toBe(0);
    expect(reads).toHaveLength(1);
  });

  it("ends a nested branch after its loaded children", () => {
    const load = vi.fn();
    const { container } = render(
      <Tree
        items={[
          { id: "a", hasChildren: true },
          { id: "a1", parentId: "a" },
          { id: "a2", parentId: "a" },
          { id: "b" },
        ]}
        label="Nested"
        more={new Map([["a", { load }]])}
        renderItem={(item) => <span>{item.id}</span>}
      />,
    );
    const top = (id: string) =>
      (container.querySelector(`[data-tree-id="${id}"]`) as HTMLElement).style
        .top;
    expect([top("a"), top("a1"), top("a2"), top("b")]).toEqual([
      "0px",
      "28px",
      "56px",
      "168px",
    ]);
    const first = container.querySelector(
      '[data-tree-more="placeholder"]',
    ) as HTMLElement;
    expect(first.style.top).toBe("84px");
    expect(first.style.paddingInlineStart).toBe("22px");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
