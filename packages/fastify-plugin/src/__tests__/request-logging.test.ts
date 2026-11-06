import Fastify from "fastify";
import { expect, it } from "vitest";
import {
  apiErrorResponse,
  apiNotFoundResponse,
  errorLogFields,
  requestLogFields,
} from "../request-logging.js";

it.each([400, 401, 404, 422, 429, 500, 502, 503, 504])(
  "preserves explicit HTTP error status %i without its exception message",
  async (statusCode) => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(apiErrorResponse);
    app.get("/unavailable", async () => {
      throw Object.assign(new Error("synthetic-exception-secret"), {
        statusCode,
      });
    });
    try {
      const response = await app.inject({ url: "/unavailable" });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: statusCode >= 500 ? "Internal server error" : "Invalid request",
      });
      expect(response.body).not.toContain("synthetic-exception-secret");
    } finally {
      await app.close();
    }
  },
);

it.each([200, 399, 400.5, 600, Number.NaN])(
  "normalizes invalid error status %s to 500",
  async (statusCode) => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(apiErrorResponse);
    app.get("/failed", async () => {
      throw Object.assign(new Error("synthetic-exception-secret"), {
        statusCode,
      });
    });
    try {
      const response = await app.inject({ url: "/failed" });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "Internal server error" });
    } finally {
      await app.close();
    }
  },
);

it("logs route templates and error types without URL, header, body or exception secrets", async () => {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      stream: {
        write: (line: string) => {
          lines.push(line);
        },
      },
      serializers: { req: requestLogFields, err: errorLogFields },
    },
  });
  app.setErrorHandler(apiErrorResponse);
  app.setNotFoundHandler(apiNotFoundResponse);
  app.post("/hooks/:token", async () => ({ ok: true }));
  app.get("/connection-authorizations/callback", async () => {
    throw new Error("synthetic-exception-secret");
  });
  try {
    await app.inject({
      method: "POST",
      url: "/hooks/synthetic-webhook-secret?key=synthetic-query-secret",
      headers: { authorization: "Bearer synthetic-header-secret" },
      payload: { value: "synthetic-body-secret" },
    });
    await app.inject({
      url: "/connection-authorizations/callback?state=synthetic-state-secret&code=synthetic-code-secret",
    });
    await app.inject({ url: "/missing/synthetic-unmatched-secret" });
    const recorded = lines.join("\n");
    expect(recorded).not.toMatch(/synthetic-\S*-secret/);
    expect(recorded).toContain("/hooks/:token");
    expect(recorded).toContain("/connection-authorizations/callback");
    expect(recorded).toContain('"errorType":"Error"');
  } finally {
    await app.close();
  }
});
