import { expect, it } from "vitest";
import { itemsSource } from "./items.js";

it("refreshes conditional static branches through one source without changing stable row IDs", async () => {
  let visible = true;
  const source = itemsSource({
    ownerId: "links",
    items: [
      {
        id: "folder",
        label: "Work",
        items: [
          { id: "always", label: "Always", url: "file:notes.md" },
          { id: "context", label: "Context", url: "file:context.md" },
        ],
      },
    ],
    keep: (item) => item.id !== "context" || visible,
  });
  const read = (parentId: string | null) =>
    source.load({ parentId, signal: new AbortController().signal });
  expect((await read(null)).items.map((row) => row.id)).toEqual(["folder"]);
  expect((await read("folder")).items.map((row) => row.id)).toEqual([
    "always",
    "context",
  ]);
  visible = false;
  expect((await read("folder")).items.map((row) => row.id)).toEqual(["always"]);
  expect((await read(null)).items.map((row) => row.id)).toEqual(["folder"]);
  visible = true;
  expect((await read("folder")).items.map((row) => row.id)).toEqual([
    "always",
    "context",
  ]);
});
