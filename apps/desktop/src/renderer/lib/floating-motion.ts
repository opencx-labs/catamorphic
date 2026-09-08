import { useCallback, useEffect, useRef, useState } from "react";

/** Keep the live surface mounted until its paired exit finishes. */
export function useFloatingMotion(identity: string | undefined) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    identityRef.current = identity;
    setClosing(false);
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    return () => clearTimeout(timerRef.current);
  }, [identity]);
  const dismiss = useCallback((finish: () => void) => {
    if (!identityRef.current) {
      finish();
      return;
    }
    if (timerRef.current !== undefined) return;
    const target = identityRef.current;
    setClosing(true);
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 200;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      if (identityRef.current !== target) return;
      finish();
      setClosing(false);
    }, duration);
  }, []);
  return { closing, dismiss };
}
