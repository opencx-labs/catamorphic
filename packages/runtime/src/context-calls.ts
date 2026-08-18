import {
  DOCUMENTS_CAPABILITY,
  type RuntimeHostCallTransition,
} from "./supervisor-protocol.js";

export type HostCallBuilder = (
  capability: string,
  fn: string,
  args: unknown,
) => RuntimeHostCallTransition;

/** The `host_call` transition a boundary returns (ADR 0055). */
export function hostCallTransition(
  capability: string,
  fn: string,
  args: unknown,
): RuntimeHostCallTransition {
  return { __catamorphicDurableTransition: "host_call", capability, fn, args };
}

/**
 * `context.host.acme.crm.lookupCustomer(args)` → a host_call transition for
 * capability "acme.crm", fn "lookupCustomer". Every property access extends
 * the dotted path; the call names the last segment as the function.
 */
export function hostNamespace(
  path: readonly string[],
  call: HostCallBuilder = hostCallTransition,
): unknown {
  return new Proxy(function target() {}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return hostNamespace([...path, prop], call);
    },
    apply(_t, _this, argList) {
      const fn = path.at(-1);
      const capability = path.slice(0, -1).join(".");
      if (!fn || !capability) {
        throw new Error(
          "context.host calls need a capability namespace and a function: context.host.<capability>.<fn>(args)",
        );
      }
      return call(capability, fn, argList[0]);
    },
  });
}

/** `context.documents`: the built-in documents capability, one fn per op. */
export function documentsCalls(
  call: HostCallBuilder = hostCallTransition,
): Record<string, (args: unknown) => RuntimeHostCallTransition> {
  return Object.fromEntries(
    ["list", "read", "write", "delete", "history", "search"].map((fn) => [
      fn,
      (args: unknown) => call(DOCUMENTS_CAPABILITY, fn, args),
    ]),
  );
}
