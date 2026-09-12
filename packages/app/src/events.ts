/** Reference-counted fanout: one upstream listener, no listeners for idle sources. */
export function shareEvent<T>(
  connect: (publish: (event: T) => void) => () => void,
) {
  const listeners = new Set<(event: T) => void>();
  let disconnect: (() => void) | undefined;
  return (listener: (event: T) => void) => {
    listeners.add(listener);
    if (!disconnect)
      disconnect = connect((event) => {
        for (const receive of [...listeners]) receive(event);
      });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        disconnect?.();
        disconnect = undefined;
      }
    };
  };
}
