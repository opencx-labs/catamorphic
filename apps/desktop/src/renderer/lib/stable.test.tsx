// @vitest-environment jsdom
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  shallowEqual,
  useLatestHandlers,
  useStableEntries,
  useStableValue,
} from "./stable.js";

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

it("keeps a memoised child still while its handlers run the latest closure", () => {
  let renders = 0;
  let press = () => {};
  const Child = memo(function Child({
    onPress,
    onMaybe,
  }: {
    onPress: () => string;
    onMaybe?: () => string;
  }) {
    renders += 1;
    press = () => (onMaybe ? onMaybe() : onPress());
    return null;
  });
  const said: string[] = [];
  function Parent({ word, extra }: { word: string; extra: boolean }) {
    const handlers = useLatestHandlers({
      onPress: () => {
        said.push(word);
        return word;
      },
      onMaybe: extra
        ? () => {
            said.push(`maybe ${word}`);
            return word;
          }
        : undefined,
    });
    return <Child onPress={handlers.onPress} onMaybe={handlers.onMaybe} />;
  }
  act(() => root.render(<Parent word="one" extra={false} />));
  act(() => root.render(<Parent word="two" extra={false} />));
  expect(renders).toBe(1);
  press();
  expect(said).toEqual(["two"]);
  // A handler that arrives is a new prop: the child sees it.
  act(() => root.render(<Parent word="three" extra />));
  expect(renders).toBe(2);
  press();
  expect(said).toEqual(["two", "maybe three"]);
});

it("keeps equal entries and an unchanged list by identity", () => {
  const lists: { id: string; label: string }[][] = [];
  function List({ labels }: { labels: string[] }) {
    lists.push(
      useStableEntries(
        labels.map((label, index) => ({ id: String(index), label })),
        (entry) => entry.id,
      ),
    );
    return null;
  }
  act(() => root.render(<List labels={["a", "b"]} />));
  act(() => root.render(<List labels={["a", "b"]} />));
  expect(lists[1]).toBe(lists[0]);
  act(() => root.render(<List labels={["a", "c"]} />));
  expect(lists[2]).not.toBe(lists[0]);
  expect(lists[2]?.[0]).toBe(lists[0]?.[0]);
  expect(lists[2]?.[1]).not.toBe(lists[0]?.[1]);
  expect(lists[2]?.[1]?.label).toBe("c");
  // An entry that left is not the one that comes back changed.
  act(() => root.render(<List labels={["a"]} />));
  act(() => root.render(<List labels={["a", "d"]} />));
  expect(lists[4]?.[1]?.label).toBe("d");
});

it("keeps a value while it is equal to the last", () => {
  const values: string[][] = [];
  function Value({ words }: { words: string[] }) {
    values.push(useStableValue(words, (a, b) => a.join() === b.join()));
    return null;
  }
  act(() => root.render(<Value words={["a"]} />));
  act(() => root.render(<Value words={["a"]} />));
  act(() => root.render(<Value words={["b"]} />));
  expect(values[1]).toBe(values[0]);
  expect(values[2]).toEqual(["b"]);
});

it("compares own fields by identity", () => {
  const shared = { deep: true };
  expect(shallowEqual({ a: 1, b: shared }, { a: 1, b: shared })).toBe(true);
  expect(shallowEqual({ a: 1, b: { deep: true } }, { a: 1, b: shared })).toBe(
    false,
  );
  expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(shallowEqual({ a: undefined }, { b: undefined })).toBe(false);
});
