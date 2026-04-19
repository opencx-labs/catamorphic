#!/usr/bin/env node
import { runMigrate } from "./migrate.js";
import { runReset } from "./reset.js";
import { runStatus } from "./status.js";

const command = process.argv[2] ?? "migrate";

switch (command) {
  case "migrate":
    await runMigrate();
    break;
  case "status":
    await runStatus();
    break;
  case "reset":
    await runReset();
    break;
  default:
    console.error("Usage: catamorphic-db <migrate|status|reset>");
    process.exit(1);
}
