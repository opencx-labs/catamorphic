import { createCatamorphicClient } from "@catamorphic/api-client";

export const api = createCatamorphicClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
});
