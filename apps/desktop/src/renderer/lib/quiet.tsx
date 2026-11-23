import { type ComponentType, memo, useRef, useState } from "react";

/**
 * A component that renders only when what it is given changes, whatever
 * closures its parent rebuilt (ADR 0340): each function it is given stays
 * the same for its life and runs the latest one, and everything else is
 * compared by identity.
 *
 * Only for a component whose function props are handlers: called for an
 * event, from an effect, or to register something. One it calls while it
 * renders would keep its first answer on screen; give that component the
 * answer instead. A handler may come and go between renders.
 */
export function quiet<P extends object>(
  Component: ComponentType<P>,
): ComponentType<P> {
  const Memoised = memo(Component);
  function Quiet(props: P) {
    const latest = useRef(props);
    latest.current = props;
    const [handlers] = useState(
      () => new Map<PropertyKey, (...args: unknown[]) => unknown>(),
    );
    const given = { ...props };
    for (const key of Object.keys(given)) {
      if (typeof Reflect.get(given, key) !== "function") continue;
      const handler =
        handlers.get(key) ??
        ((...args: unknown[]) => {
          const current: unknown = Reflect.get(latest.current, key);
          return typeof current === "function"
            ? Reflect.apply(current, undefined, args)
            : undefined;
        });
      handlers.set(key, handler);
      Reflect.set(given, key, handler);
    }
    return <Memoised {...given} />;
  }
  Quiet.displayName = `Quiet(${Component.displayName ?? Component.name})`;
  return Quiet;
}
