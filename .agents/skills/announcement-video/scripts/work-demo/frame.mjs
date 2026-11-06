// Runs an expression in the app frame (apps are OOPIFs) and prints the result.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: film scripts run outside turbo
const port = process.env.CDP_PORT;
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) =>
  r.json(),
);
const t = targets.find((x) => x.type === "iframe" && /\/apps\//.test(x.url));
if (!t) {
  console.log("no app frame");
  process.exit(0);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((y, n) => {
  ws.onopen = y;
  ws.onerror = n;
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) {
    console.log(
      JSON.stringify(
        m.result?.result?.value ??
          m.result?.exceptionDetails?.exception?.description ??
          m.result,
        null,
        2,
      ),
    );
    ws.close();
    process.exit(0);
  }
};
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: process.argv[2],
      returnByValue: true,
      awaitPromise: true,
    },
  }),
);
