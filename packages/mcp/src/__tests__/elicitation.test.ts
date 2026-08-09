import { describe, expect, it } from "vitest";
import { parseElicitRequest } from "../elicitation.js";

describe("parseElicitRequest", () => {
  it("parses a form request with string, boolean, and enum fields", () => {
    const parsed = parseElicitRequest({
      mode: "form",
      message: "Configure the connection",
      requestedSchema: {
        type: "object",
        required: ["apiBase"],
        properties: {
          apiBase: {
            type: "string",
            title: "API base",
            format: "uri",
            default: "https://api.example.com",
          },
          verbose: { type: "boolean", default: false },
          region: {
            oneOf: [
              { const: "us", title: "United States" },
              { const: "eu", title: "Europe" },
            ],
          },
        },
      },
    });
    expect(parsed).toEqual({
      mode: "form",
      message: "Configure the connection",
      fields: [
        {
          name: "apiBase",
          type: "string",
          title: "API base",
          description: undefined,
          required: true,
          format: "uri",
          default: "https://api.example.com",
        },
        {
          name: "verbose",
          type: "boolean",
          title: undefined,
          description: undefined,
          required: false,
          default: false,
        },
        {
          name: "region",
          type: "enum",
          title: undefined,
          description: undefined,
          required: false,
          options: [
            { value: "us", label: "United States" },
            { value: "eu", label: "Europe" },
          ],
        },
      ],
    });
  });

  it("parses a multi-select array enum", () => {
    const parsed = parseElicitRequest({
      message: "Pick scopes",
      requestedSchema: {
        type: "object",
        properties: {
          scopes: { type: "array", items: { enum: ["read", "write"] } },
        },
      },
    });
    expect(parsed).toMatchObject({
      mode: "form",
      fields: [
        {
          name: "scopes",
          type: "enum",
          multiSelect: true,
          options: [
            { value: "read", label: "read" },
            { value: "write", label: "write" },
          ],
        },
      ],
    });
  });

  it("parses a URL-mode request and rejects non-https urls", () => {
    expect(
      parseElicitRequest({
        mode: "url",
        message: "Sign in",
        url: "https://auth.example.com/oauth",
      }),
    ).toEqual({
      mode: "url",
      message: "Sign in",
      url: "https://auth.example.com/oauth",
    });
    expect(
      parseElicitRequest({ mode: "url", message: "x", url: "http://insecure" }),
    ).toBeNull();
    expect(
      parseElicitRequest({
        mode: "url",
        message: "x",
        url: "javascript:alert(1)",
      }),
    ).toBeNull();
  });
});
