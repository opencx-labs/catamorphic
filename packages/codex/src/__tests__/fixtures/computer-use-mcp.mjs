import { createInterface } from "node:readline";

const send = (value) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
let pending;
let calls = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize")
    send({
      id: req.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "native-computer-use-fixture", version: "1" },
      },
    });
  if (req.method === "tools/list")
    send({
      id: req.id,
      result: {
        tools: [
          {
            name: "inspect_window",
            description: "Read a test window screenshot",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
  if (req.method === "tools/call") {
    pending = req.id;
    calls++;
    send({
      id: "permission",
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Allow fixture window access?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
  }
  if (req.id === "permission") {
    const accepted = req.result?.action === "accept";
    send({
      id: pending,
      result: accepted
        ? {
            content: [
              { type: "text", text: `Window approved; call ${calls}` },
              {
                type: "image",
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4H6oERAwQCgAsagXZAojougAAAABJRU5ErkJggg==",
              },
            ],
          }
        : {
            isError: true,
            content: [
              { type: "text", text: `Window access declined; call ${calls}` },
            ],
          },
    });
  }
});
