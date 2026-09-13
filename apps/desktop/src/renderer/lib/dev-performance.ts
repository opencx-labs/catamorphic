/** React 19 development tracks otherwise retain every render in UserTiming. */
function isReactMeasure(entry: PerformanceEntry): boolean {
  if (!(entry instanceof PerformanceMeasure)) return false;
  const detail: unknown = entry.detail;
  if (
    typeof detail !== "object" ||
    detail === null ||
    !("devtools" in detail)
  ) {
    return false;
  }
  const devtools = detail.devtools;
  return (
    typeof devtools === "object" &&
    devtools !== null &&
    (("track" in devtools && devtools.track === "Components ⚛") ||
      ("trackGroup" in devtools && devtools.trackGroup === "Scheduler ⚛"))
  );
}

if (import.meta.env.DEV) {
  // Delivery to observers and DevTools happens independently of the retained
  // UserTiming buffer. Keep the profiling events, but release their copied
  // prop details once delivered instead of accumulating hours of idle polls.
  // Do not clear application marks or unrelated measurements.
  const observer = new PerformanceObserver((list) => {
    const names = new Set(
      list
        .getEntries()
        .filter(isReactMeasure)
        .map((entry) => entry.name),
    );
    for (const name of names) performance.clearMeasures(name);
  });
  observer.observe({ type: "measure", buffered: true });
  import.meta.hot?.dispose(() => observer.disconnect());
}
