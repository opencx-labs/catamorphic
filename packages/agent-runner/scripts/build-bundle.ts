/**
 * Bundles the sandbox runner into one file, `dist/runner.mjs`, with every
 * dependency inlined: a sandbox has Bun and nothing of ours installed.
 */
const result = await Bun.build({
  entrypoints: [new URL("../src/sandbox-main.ts", import.meta.url).pathname],
  target: "bun",
  format: "esm",
  minify: false,
  sourcemap: "none",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const [output] = result.outputs;
if (!output) throw new Error("The runner bundle produced no output");
await Bun.write(
  new URL("../dist/runner.mjs", import.meta.url).pathname,
  output,
);
console.log(`dist/runner.mjs ${(output.size / 1024).toFixed(0)} KiB`);
