// Ad-hoc: node poke.mjs '<js expression using lib helpers>'

import { ws } from "./cdp.mjs";
import * as lib from "./lib.mjs";

const arg = process.argv[2];
const body = arg.endsWith(".js")
  ? (await import("node:fs")).readFileSync(arg, "utf8")
  : arg;
const fn = new Function(
  ...Object.keys(lib),
  `return (async () => { ${body} })()`,
);
const out = await fn(...Object.values(lib));
if (out !== undefined) console.log(JSON.stringify(out, null, 2));
ws.close();
setTimeout(() => process.exit(0), 100);
