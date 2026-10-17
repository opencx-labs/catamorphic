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
import { CollectionTree, focusTreeRow, onTreeLeave, Tree } from "../tree.js";

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
  it("hands its scroller to the host once, and takes back what it set up", () => {
    const cleanup = vi.fn();
    const onViewport = vi.fn((_viewport: HTMLDivElement) => cleanup);
    const view = (label: string) => (
      <Tree
        items={[{ id: "a" }, { id: "b" }]}
        label={label}
        className="cat-edge-fade"
        onViewport={onViewport}
        renderItem={(item) => <span>{item.id}</span>}
      />
    );
    const mounted = render(view("Faded tree"));
    expect(onViewport).toHaveBeenCalledTimes(1);
    const scroller = onViewport.mock.calls[0]?.[0];
    expect(scroller?.matches("[data-tree-viewport].cat-edge-fade")).toBe(true);
    mounted.rerender(view("Faded tree, renamed"));
    expect(onViewport).toHaveBeenCalledTimes(1);
    mounted.unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("keeps a row the keyboard reaches clear of its scroller's scroll padding", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
    }));
    const { container } = render(
      <Tree
        items={items}
        label="Padded tree"
        height={280}
        renderItem={(item) => <span>{item.id}</span>}
      />,
    );
    const viewport = container.querySelector<HTMLElement>(
      "[data-tree-viewport]",
    );
    if (!viewport) throw new Error("no viewport");
    // A faded scroller's, as the host's stylesheet gives it.
    viewport.style.setProperty("scroll-padding-top", "24px");
    viewport.style.setProperty("scroll-padding-bottom", "24px");
    const row = (id: string) =>
      screen.getByText(id).closest<HTMLElement>('[role="treeitem"]');
    // Down to the row just past the view: it stops 24px short of the end.
    for (let index = 0; index < 10; index += 1)
      fireEvent.keyDown(row(String(index)) as HTMLElement, {
        key: "ArrowDown",
      });
    expect(viewport.scrollTop).toBe(10 * 28 + 28 + 24 - 280);
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
  it("ends a row with its disclosure, so every label starts in one place", () => {
    const toggle = vi.fn();
    const { container } = render(
      <CollectionItemView
        id="folder"
        label="Folder"
        expanded={false}
        onToggle={toggle}
        menu={[{ id: "rename", label: "Rename", run: () => {} }]}
      />,
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons[0]?.className).toBe("cat-collection-label");
    expect(buttons.at(-1)?.getAttribute("aria-label")).toBe("Expand Folder");
    fireEvent.click(screen.getByRole("button", { name: "Expand Folder" }));
    expect(toggle).toHaveBeenCalledTimes(1);
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
  const rowsOf = (offset: number, count: number) =>
    Array.from({ length: Math.max(0, count) }, (_, index) => ({
      id: `r${offset + index}`,
      label: `Row ${offset + index}`,
    }));
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
            items: rowsOf(offset, Math.min(size, total - offset)),
            cursor: next < total ? String(next) : undefined,
          };
          reads.push({ cursor, resolve: () => resolve(page), reject });
        }),
    );
    return { collection: createCollection<Row>({ source: { load } }), reads };
  };
  /** The same pages, answered at once (a cached read). */
  const instantSource = (total: number, size: number) => {
    const load = vi.fn(async ({ cursor }: { cursor?: string }) => {
      const offset = cursor ? Number(cursor) : 0;
      const next = offset + size;
      return {
        items: rowsOf(offset, Math.min(size, total - offset)),
        cursor: next < total ? String(next) : undefined,
      };
    });
    return { collection: createCollection<Row>({ source: { load } }), load };
  };
  const view = (
    collection: ReturnType<typeof pagedSource>["collection"],
    options: {
      active?: boolean;
      height?: number;
      tail?: Row[];
      project?: (items: readonly Row[]) => readonly Row[];
      groupBy?: (item: Row) => string;
    } = {},
  ) => (
    <CollectionTree
      collection={collection}
      active={options.active ?? true}
      label="Chats"
      height={options.height ?? 140}
      rowHeight={28}
      tail={options.tail}
      project={options.project}
      groupBy={options.groupBy}
      renderItem={(item) => <button type="button">{item.label}</button>}
    />
  );
  /** Placeholders holding the end, not ones fading out. */
  const placeholders = (container: HTMLElement) =>
    container.querySelectorAll(
      '[data-tree-more="placeholder"]:not(.cat-row-exit)',
    ).length;
  const viewport = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-tree-viewport]") ??
    document.body;
  /** A wheel turn that scrolls the list to `top`. */
  const wheelTo = (container: HTMLElement, top: number) => {
    const element = viewport(container);
    fireEvent.wheel(element);
    element.scrollTop = top;
    fireEvent.scroll(element);
  };
  const showMore = () =>
    screen.queryByRole("button", { name: "Show more in Chats" });

  it("reads the next page as the person nears the end and says so", async () => {
    const { collection, reads } = pagedSource(25, 10);
    const { container } = render(view(collection));
    await act(async () => reads[0]?.resolve());
    expect(await screen.findByRole("button", { name: "Row 0" })).toBeTruthy();
    // The end waits as still placeholders, out of reach for now; the
    // tree says more rows exist than are loaded.
    expect(placeholders(container)).toBe(3);
    expect(
      screen.getAllByRole("treeitem")[0]?.getAttribute("aria-setsize"),
    ).toBe("-1");
    expect(reads).toHaveLength(1);
    // Within one viewport (five rows) of the end, the next page is read.
    await act(async () => wheelTo(container, 56));
    expect(reads.map((read) => read.cursor)).toEqual([undefined, "10"]);
    expect(screen.getByRole("status").textContent).toBe(
      "Loading more in Chats",
    );
    await act(async () => reads[1]?.resolve());
    expect(await screen.findByRole("button", { name: "Row 10" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("10 more in Chats");
    // New rows arrive with the list motion where the placeholders stood;
    // the placeholders moved to the new end without sweeping across them.
    expect(
      screen
        .getByRole("button", { name: "Row 10" })
        .closest('[role="treeitem"]')?.className,
    ).toBe("cat-row-enter");
    expect(
      container.querySelectorAll('[data-tree-more="placeholder"]'),
    ).toHaveLength(0);
    expect(viewport(container).firstElementChild).toHaveProperty(
      "style.height",
      `${23 * 28}px`,
    );
    expect(reads).toHaveLength(2);
    await act(async () => wheelTo(container, 28 * 18));
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
    expect(
      screen.getAllByRole("treeitem")[0]?.getAttribute("aria-setsize"),
    ).toBe("25");
    expect(reads).toHaveLength(3);
  });

  it("keeps reading when a page lands before the tree sees it loading", async () => {
    const { collection, load } = instantSource(100, 2);
    const { container } = render(view(collection, { height: 280 }));
    await screen.findByRole("button", { name: "Row 1" });
    // The whole list fits: nothing reads before the person moves it.
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(showMore()).toBeTruthy();
    await act(async () => {
      fireEvent.wheel(viewport(container));
    });
    // Three reads per gesture, each one landing at once.
    await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    await screen.findByRole("button", { name: "Row 7" });
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(4);
    expect(screen.getAllByRole("treeitem")).toHaveLength(8);
    expect(placeholders(container)).toBe(0);
    expect(showMore()).toBeTruthy();
    // Show more is a gesture of its own: it reads now, and on while the
    // pages keep moving the end.
    await act(async () => {
      showMore()?.click();
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(7));
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(7);
  });

  it("stops after a page that shows nothing new, until the person moves", async () => {
    const { collection, reads } = pagedSource(40, 10);
    const { container } = render(
      view(collection, {
        // A display filter that shows two rows of forty.
        project: (items) =>
          items.filter((item) => item.id === "r0" || item.id === "r35"),
      }),
    );
    await act(async () => reads[0]?.resolve());
    await screen.findByRole("button", { name: "Row 0" });
    expect(showMore()).toBeTruthy();
    await act(async () => wheelTo(container, 0));
    expect(reads).toHaveLength(2);
    // Rows 10 to 19 show nothing: the end did not move, so it stops.
    await act(async () => reads[1]?.resolve());
    await act(async () => {});
    expect(reads).toHaveLength(2);
    expect(showMore()).toBeTruthy();
    expect(placeholders(container)).toBe(0);
    // Each gesture reads one more page while nothing shows.
    await act(async () => wheelTo(container, 0));
    expect(reads).toHaveLength(3);
    await act(async () => reads[2]?.resolve());
    await act(async () => {});
    expect(reads).toHaveLength(3);
    // A press on Show more reads on its click, once, and keeps it there
    // until then.
    const button = showMore();
    if (!button) throw new Error("Show more is missing");
    await act(async () => {
      fireEvent.pointerDown(button);
    });
    expect(reads).toHaveLength(3);
    expect(showMore()).toBe(button);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(reads).toHaveLength(4);
    await act(async () => reads[3]?.resolve());
    expect(await screen.findByRole("button", { name: "Row 35" })).toBeTruthy();
    expect(showMore()).toBeNull();
  });

  it("does not read on into collapsed groups", async () => {
    const { collection, reads } = pagedSource(300, 30);
    const { container } = render(
      view(collection, { groupBy: () => "Earlier" }),
    );
    await act(async () => reads[0]?.resolve());
    await screen.findByRole("button", { name: "Expand Earlier" });
    // The end shows at open, but nothing reads on its own.
    await act(async () => {});
    expect(reads).toHaveLength(1);
    expect(showMore()).toBeTruthy();
    await act(async () => wheelTo(container, 0));
    expect(reads).toHaveLength(2);
    // Its rows went into the closed group: the end did not move.
    await act(async () => reads[1]?.resolve());
    await act(async () => {});
    expect(reads).toHaveLength(2);
    expect(showMore()).toBeTruthy();
  });

  it("ends a branch with its error and Retry, beside the tree", async () => {
    const { collection, reads } = pagedSource(15, 10);
    const { container } = render(view(collection));
    await act(async () => reads[0]?.resolve());
    await screen.findByRole("button", { name: "Row 0" });
    await act(async () => wheelTo(container, 56));
    await act(async () => reads[1]?.reject(new Error("Offline")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Offline");
    // A tree owns only its items; the alert sits beside it.
    expect(screen.getByRole("tree").contains(alert)).toBe(false);
    expect(placeholders(container)).toBe(0);
    // A failed page is not read again on its own as the person scrolls.
    await act(async () => wheelTo(container, 84));
    expect(reads).toHaveLength(2);
    // Retry keeps keyboard focus in the list, on the last loaded row.
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(document.activeElement?.getAttribute("data-tree-id")).toBe("r9");
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
    const { container } = render(view(collection, { active: false }));
    await screen.findByRole("button", { name: "Row 0" });
    await act(async () => wheelTo(container, 28 * 8));
    expect(placeholders(container)).toBe(0);
    expect(showMore()).toBeNull();
    expect(reads).toHaveLength(1);
  });

  it("shows a known later row past the end without reading up to it", async () => {
    const { collection, reads } = pagedSource(15, 10);
    const { container } = render(
      view(collection, { tail: [{ id: "r14", label: "Row 14" }] }),
    );
    await act(async () => reads[0]?.resolve());
    const tailRow = await screen.findByRole("button", { name: "Row 14" });
    // After the loaded rows and the placeholders holding the end.
    expect(tailRow.closest<HTMLElement>('[role="treeitem"]')?.style.top).toBe(
      `${13 * 28}px`,
    );
    expect(reads).toHaveLength(1);
    await act(async () => wheelTo(container, 56));
    await act(async () => reads[1]?.resolve());
    await screen.findByRole("button", { name: "Row 10" });
    // Its page brought it in: one row, in its place.
    expect(screen.getAllByRole("button", { name: "Row 14" })).toHaveLength(1);
    expect(
      screen
        .getByRole("button", { name: "Row 14" })
        .closest<HTMLElement>('[role="treeitem"]')?.style.top,
    ).toBe(`${14 * 28}px`);
  });

  it("ends a nested branch after its loaded children", async () => {
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
    const top = (selector: string) =>
      container.querySelector<HTMLElement>(selector)?.style.top;
    // Nothing reads before the person touches the list: Show more waits.
    expect(load).not.toHaveBeenCalled();
    expect(top('[data-tree-more="paused"]')).toBe("84px");
    expect(top('[data-tree-id="b"]')).toBe("112px");
    await act(async () => {
      fireEvent.pointerDown(viewport(container));
    });
    expect([top('[data-tree-id="a"]'), top('[data-tree-id="a1"]')]).toEqual([
      "0px",
      "28px",
    ]);
    const first = container.querySelector<HTMLElement>(
      '[data-tree-more="placeholder"]',
    );
    expect(first?.style.top).toBe("84px");
    expect(first?.style.paddingInlineStart).toBe("22px");
    expect(top('[data-tree-id="b"]')).toBe("168px");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("keyboard focus in a tree", () => {
  const items = [
    { id: "folder" },
    { id: "a", parentId: "folder" },
    { id: "b", parentId: "folder" },
    { id: "c" },
  ];
  const view = (selectedId?: string, shown = items) => (
    <Tree
      items={shown}
      label="Focus tree"
      indent={14}
      selectedId={selectedId}
      renderItem={(item) => <span>{item.id}</span>}
    />
  );
  const row = (id: string) => {
    const found = document.querySelector<HTMLElement>(`[data-tree-id="${id}"]`);
    if (!found) throw new Error(`no row ${id}`);
    return found;
  };
  const scroller = () => {
    const found = document.querySelector("[data-tree-viewport]");
    if (!found) throw new Error("no viewport");
    return found;
  };

  it("sets each row in by its depth, so its own box carries the indent", () => {
    render(view());
    expect(row("folder").style.left).toBe("0px");
    expect(row("a").style.left).toBe("14px");
  });

  it("focuses the first, last or selected row a host asks for, within the call", () => {
    // What has focus as the call returns: a host can count the move as its own.
    const ask = (which: "first" | "last" | "selected") => {
      let handled = false;
      let focused: Element | null = null;
      act(() => {
        handled = focusTreeRow({ scroller: scroller(), which });
        focused = document.activeElement;
      });
      return { handled, focused };
    };
    const { rerender } = render(view());
    expect(ask("selected")).toEqual({
      handled: false,
      focused: document.body,
    });
    expect(ask("last")).toEqual({ handled: true, focused: row("c") });
    rerender(view("b"));
    expect(ask("selected")).toEqual({ handled: true, focused: row("b") });
    expect(ask("first")).toEqual({ handled: true, focused: row("folder") });
    // The arrows go on from where the host put focus.
    fireEvent.keyDown(row("folder"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("a"));
  });

  it("goes on from a row focus reached another way", () => {
    render(view());
    // The roving row was "folder"; focus reaches "b" by a click or a host.
    act(() => row("b").focus());
    fireEvent.keyDown(row("b"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(row("a"));
  });

  it("hands an arrow past either end to a host, and keeps the key itself", () => {
    const { container } = render(view());
    const leaves: string[] = [];
    let take = false;
    const stop = onTreeLeave({
      container,
      onLeave: ({ direction, scroller: from }) => {
        leaves.push(`${direction} ${from === scroller()}`);
        return take;
      },
    });
    const press = (key: string, at: HTMLElement) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        at.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    act(() => row("c").focus());
    // No host goes on: the key stays the tree's, so nothing around scrolls.
    expect(press("ArrowDown", row("c"))).toBe(true);
    expect(document.activeElement).toBe(row("c"));
    take = true;
    act(() => row("folder").focus());
    expect(press("ArrowUp", row("folder"))).toBe(true);
    // Between rows, no host hears of it.
    press("ArrowDown", row("folder"));
    expect(document.activeElement).toBe(row("a"));
    expect(leaves).toEqual(["down true", "up true"]);
    stop();
  });

  it("keeps an arrow past the last loaded row while more is to load", () => {
    const { container } = render(
      <Tree
        items={[{ id: "x" }, { id: "y" }]}
        label="Paged"
        more={new Map([[null, { load: () => {} }]])}
        renderItem={(item) => <span>{item.id}</span>}
      />,
    );
    const onLeave = vi.fn(() => true);
    const stop = onTreeLeave({ container, onLeave });
    act(() => row("y").focus());
    fireEvent.keyDown(row("y"), { key: "ArrowDown" });
    expect(onLeave).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row("y"));
    stop();
  });

  it("follows a focused row that goes, and leaves focus elsewhere be", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    const { rerender } = render(view());
    const without = (id: string) => items.filter((item) => item.id !== id);
    // Focused in the list, the row goes: focus moves to its parent.
    act(() => row("b").focus());
    rerender(view(undefined, without("b")));
    expect(document.activeElement).toBe(row("folder"));
    // Clicked once, then the person works elsewhere: the row going takes
    // nothing from them.
    rerender(view());
    act(() => row("a").focus());
    act(() => outside.focus());
    rerender(view(undefined, without("a")));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("draws one ring on the focused row's box that glides as focus moves", () => {
    // jsdom has no :focus-visible; the keyboard is leading here.
    const matches = HTMLElement.prototype.matches;
    const visible = vi
      .spyOn(HTMLElement.prototype, "matches")
      .mockImplementation(function (this: HTMLElement, selector: string) {
        return selector === ":focus-visible"
          ? document.activeElement === this
          : matches.call(this, selector);
      });
    render(view());
    const ring = () => document.querySelector<HTMLElement>("[data-tree-focus]");
    expect(ring()).toBeNull();
    act(() => row("folder").focus());
    expect(ring()?.style.top).toBe("0px");
    expect(ring()?.style.left).toBe("0px");
    // It arrives where focus enters, riding its row's own slide, then
    // glides from row to row (the stylesheet's glide).
    expect(ring()?.hasAttribute("data-glide")).toBe(false);
    expect(ring()?.style.transition).toMatch(/^top /);
    fireEvent.keyDown(row("folder"), { key: "ArrowDown" });
    expect(ring()?.style.top).toBe("28px");
    expect(ring()?.style.left).toBe("14px");
    expect(ring()?.hasAttribute("data-glide")).toBe(true);
    expect(ring()?.style.transition).toBe("");
    // Glided there, it rides the row again.
    act(() => {
      ring()?.dispatchEvent(new Event("transitionend", { bubbles: true }));
    });
    expect(ring()?.hasAttribute("data-glide")).toBe(false);
    expect(ring()?.style.transition).toMatch(/^top /);
    act(() => row("a").blur());
    expect(ring()).toBeNull();
    visible.mockRestore();
  });
});
