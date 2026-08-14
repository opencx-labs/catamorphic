import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAsync } from "../use-async.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsync", () => {
  it("walks loading → ok", async () => {
    const load = deferred<string>();
    const { result } = renderHook(() => useAsync(() => load.promise, []));
    expect(result.current).toEqual({ status: "loading" });
    await act(async () => load.resolve("hello"));
    expect(result.current).toEqual({ status: "ok", value: "hello" });
  });

  it("ignores a stale resolution after deps changed", async () => {
    const loads = new Map<number, Deferred<string>>();
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => {
        return useAsync(() => {
          const d = deferred<string>();
          loads.set(id, d);
          return d.promise;
        }, [id]);
      },
      { initialProps: { id: 1 } },
    );
    rerender({ id: 2 });
    // The FIRST load resolves late — after deps moved on. It must be ignored.
    await act(async () => loads.get(1)?.resolve("stale"));
    expect(result.current).toEqual({ status: "loading" });
    await act(async () => loads.get(2)?.resolve("fresh"));
    expect(result.current).toEqual({ status: "ok", value: "fresh" });
  });

  it("surfaces errors with a retry that reloads", async () => {
    let attempt = 0;
    const { result } = renderHook(() =>
      useAsync(() => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error("boom"))
          : Promise.resolve("second try");
      }, []),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    const state = result.current;
    if (state.status !== "error") throw new Error("expected error state");
    expect(state.error.message).toBe("boom");
    act(() => state.retry());
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ok", value: "second try" }),
    );
  });
});
