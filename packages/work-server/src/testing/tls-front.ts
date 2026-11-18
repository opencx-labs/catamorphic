import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * HTTPS in front of a server on loopback, for end-to-end tests: what a
 * production Work server has (its public URL is HTTPS, which OAuth and
 * every bearer credential require), at an address of this machine its
 * sandboxes reach through their egress proxy. TLS ends here and the bytes
 * go on to the server unchanged. The certificate is for `host` alone,
 * issued by a CA made for this run with `openssl`; whatever must trust it
 * (a sandbox image) is given `ca`.
 */
export interface TlsFront {
  /** `https://<host>:<port>`. */
  url: string;
  /** The run's CA certificate, PEM. */
  ca: string;
  close(): Promise<void>;
}

export async function startTlsFront(input: {
  /** An IPv4 address of this machine: the certificate's only name. */
  host: string;
  /** The server's port on 127.0.0.1. */
  upstreamPort: number;
  /** Where the run's keys and certificates are written. */
  directory: string;
}): Promise<TlsFront> {
  const file = (name: string) => path.join(input.directory, name);
  fs.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const openssl = (args: readonly string[]) => execute("openssl", args);
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Work end-to-end test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
  ]);
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${input.host}`,
    "-keyout",
    file("server.key"),
    "-out",
    file("server.csr"),
  ]);
  fs.writeFileSync(
    file("server.ext"),
    `subjectAltName=IP:${input.host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  await openssl([
    "x509",
    "-req",
    "-in",
    file("server.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    file("server.ext"),
    "-out",
    file("server.pem"),
  ]);
  const sockets = new Set<net.Socket>();
  const server = tls.createServer(
    {
      key: fs.readFileSync(file("server.key")),
      cert: fs.readFileSync(file("server.pem")),
    },
    (socket) => {
      const upstream = net.connect(input.upstreamPort, "127.0.0.1");
      for (const each of [socket, upstream]) {
        sockets.add(each);
        each.on("close", () => sockets.delete(each));
        each.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
      }
      socket.pipe(upstream).pipe(socket);
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, input.host, () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The TLS front has no port");
  return {
    url: `https://${input.host}:${address.port}`,
    ca: fs.readFileSync(file("ca.pem"), "utf8"),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
