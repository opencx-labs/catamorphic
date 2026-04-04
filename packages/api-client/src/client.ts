import createClient from "openapi-fetch";
import type { paths } from "./schema.js";

export function createCatamorphicClient({ baseUrl }: { baseUrl: string }) {
  return createClient<paths>({ baseUrl });
}
