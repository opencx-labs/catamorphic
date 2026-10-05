import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DockerApiError,
  DockerClient,
  dockerEndpoint,
  withTag,
} from "../docker-client.js";
import { dockerFrame } from "../stream-demux.js";

/** A fake Docker Engine API on a Unix socket: just what the tests ask for. */
describe("DockerClient", () => {
  let directory: string;
  let server: http.Server;
  let client: DockerClient;
  const requests: string[] = [];
  let stdinSeen = "";

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "work-docker-"));
    requests.length = 0;
    stdinSeen = "";
    server = http.createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const url = request.url ?? "";
      if (url === "/_ping") return response.end("OK");
      if (url.startsWith("/containers/c1/exec")) return json(201, { Id: "e1" });
      if (url.startsWith("/containers/c2/exec")) return json(201, { Id: "e2" });
      if (url.startsWith("/containers/gone/exec"))
        return json(404, { message: "No such container: gone" });
      if (url === "/exec/e1/json")
        return json(200, { Running: false, ExitCode: 3 });
      if (url.startsWith("/images/missing"))
        return json(404, { message: "No such image" });
      if (url.startsWith("/images/create")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"status":"Pulling from library/x"}\n');
        response.end(
          '{"errorDetail":{"message":"pull access denied"},"error":"pull access denied"}\n',
        );
        return;
      }
      return json(500, { message: `unexpected ${url}` });
    });
    server.on("upgrade", (request, socket) => {
      requests.push(`${request.method} ${request.url} upgrade`);
      socket.write(
        "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      if (request.url === "/exec/e2/start") {
        // Input follows the request body; answer once five bytes came.
        let received = "";
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          stdinSeen = received.replace('{"Detach":false,"Tty":false}', "");
          if (stdinSeen.length >= 5) {
            socket.write(dockerFrame(1, Buffer.from(`got ${stdinSeen}`)));
            socket.end();
          }
        });
        return;
      }
      socket.write(dockerFrame(1, Buffer.from("hi ")));
      socket.write(dockerFrame(2, Buffer.from("oops")));
      socket.end(dockerFrame(1, Buffer.from("there")));
    });
    const socketPath = path.join(directory, "docker.sock");
    await new Promise<void>((resolve) =>
      server.listen(socketPath, () => resolve()),
    );
    client = new DockerClient({ socketPath });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("runs a command through the hijacked stream and reads its exit code", async () => {
    const output = await client.exec({
      container: "c1",
      cmd: ["sh", "-c", "true"],
    });
    expect(output).toEqual({ exitCode: 3, stdout: "hi there", stderr: "oops" });
    expect(requests).toEqual([
      "POST /containers/c1/exec",
      "POST /exec/e1/start upgrade",
      "GET /exec/e1/json",
    ]);
  });

  it("writes input without closing it", async () => {
    const session = await client.openExec({
      container: "c2",
      cmd: ["cat"],
      stdin: true,
    });
    await session.write("he");
    await session.write("llo");
    const frames: string[] = [];
    for await (const frame of session.frames)
      frames.push(frame.data.toString());
    expect(frames.join("")).toBe("got hello");
  });

  it("surfaces the daemon's errors", async () => {
    await expect(
      client.exec({ container: "gone", cmd: ["true"] }),
    ).rejects.toThrow("No such container: gone");
    await expect(
      client.exec({ container: "gone", cmd: ["true"] }),
    ).rejects.toBeInstanceOf(DockerApiError);
    await expect(client.pullImage("private/x")).rejects.toThrow(
      "pull access denied",
    );
    expect(await client.inspectImage("missing")).toBeUndefined();
    expect(await client.ping()).toBe(true);
  });

  it("names a tag when pulling, and reads DOCKER_HOST", () => {
    expect(withTag("alpine")).toBe("alpine:latest");
    expect(withTag("registry:5000/team/app")).toBe(
      "registry:5000/team/app:latest",
    );
    expect(withTag("node:22")).toBe("node:22");
    expect(withTag("node@sha256:abc")).toBe("node@sha256:abc");
    expect(dockerEndpoint()).toEqual({ socketPath: "/var/run/docker.sock" });
    expect(dockerEndpoint("unix:///run/user/1000/docker.sock")).toEqual({
      socketPath: "/run/user/1000/docker.sock",
    });
    expect(dockerEndpoint("tcp://10.0.0.2:2375")).toEqual({
      host: "10.0.0.2",
      port: 2375,
    });
    expect(() => dockerEndpoint("ssh://me@host")).toThrow("not supported");
  });
});
