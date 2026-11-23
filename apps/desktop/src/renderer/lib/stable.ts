import { useRef, useState } from "react";

/**
 * What lets a part of the window skip a render that changes nothing it
 * shows (ADR 0340): the window's root rebuilds its closures and lists on
 * every render, and a memoised child compares what it is given by identity.
 */

/**
 * The same functions for a component's life, each running the latest one
 * given: an event handler handed to a memoised child never makes it render,
 * and never runs a stale closure. Anything that is not a function is read
 * as it is now, so a handler may come and go.
 *
 * For handlers only. A function a child calls while it renders must change
 * identity when its answer does; give that child the answer instead.
 */
export function useLatestHandlers<T extends object>(handlers: T): T {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [facade] = useState(() => {
    const stable = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    return new Proxy<T>(handlers, {
      get(_, key) {
        if (typeof Reflect.get(latest.current, key) !== "function")
          return Reflect.get(latest.current, key);
        const existing = stable.get(key);
        if (existing) return existing;
        const created = (...args: unknown[]) => {
          const current: unknown = Reflect.get(latest.current, key);
          return typeof current === "function"
            ? Reflect.apply(current, undefined, args)
            : undefined;
        };
        stable.set(key, created);
        return created;
      },
    });
  });
  return facade;
}

/** Own enumerable fields equal by identity. */
export function shallowEqual(a: object, b: object): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      Object.is(Reflect.get(a, key), Reflect.get(b, key)),
  );
}

/**
 * A list rebuilt on every render, with the identities it had: an entry
 * equal to the one last given under its key is that entry, and a list of
 * the same entries in the same order is that list. A memoised row then
 * renders only when its own entry changed.
 */
export function useStableEntries<T extends object>(
  entries: T[],
  keyOf: (entry: T) => string,
  equal: (a: T, b: T) => boolean = shallowEqual,
): T[] {
  const last = useRef<{ list: T[]; byKey: Map<string, T> }>({
    list: [],
    byKey: new Map(),
  });
  const previous = last.current;
  const byKey = new Map<string, T>();
  const list = entries.map((entry) => {
    const key = keyOf(entry);
    const before = previous.byKey.get(key);
    const kept = before && equal(before, entry) ? before : entry;
    byKey.set(key, kept);
    return kept;
  });
  if (
    list.length === previous.list.length &&
    list.every((entry, index) => entry === previous.list[index])
  )
    return previous.list;
  last.current = { list, byKey };
  return list;
}

/** A value rebuilt on every render, as the one last given while equal to it. */
export function useStableValue<T>(value: T, equal: (a: T, b: T) => boolean): T {
  const last = useRef(value);
  if (!equal(last.current, value)) last.current = value;
  return last.current;
}
