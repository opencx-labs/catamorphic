import { setupServer } from "msw/node";
import { handlers } from "./handlers.js";

/**
 * Shared MSW server used by every test in this package. Tests register
 * additional handlers via `server.use(...)` when they need to override
 * the defaults.
 */
export const server = setupServer(...handlers);
