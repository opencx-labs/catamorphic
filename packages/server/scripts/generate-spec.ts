import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";

const app = createApp();
await app.ready();

const spec = app.swagger();
const specJson = JSON.stringify(spec, null, 2);

const outDir = path.resolve(import.meta.dirname, "../../api-client");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "openapi.json"), specJson);

console.log(`OpenAPI spec written to ${path.join(outDir, "openapi.json")}`);
await app.close();
