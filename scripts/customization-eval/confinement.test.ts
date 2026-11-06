import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { confinedAgentCommand, evalSeatbeltProfile } from "./confinement.js";

it("quotes paths in the read and write boundary without permitting the containing directory", () => {
  const profile = evalSeatbeltProfile({
    project: '/tmp/work "quoted"',
    profile: "/tmp/profile",
    auth: "/tmp/auth",
    executables: ["/tools/bun"],
  });
  expect(profile).toContain('(subpath "/tmp/work \\"quoted\\"")');
  expect(profile).not.toContain('(subpath "/tmp")');
  expect(profile).toContain("(deny file-read-data file-map-executable)");
});

it.skipIf(process.platform !== "darwin")(
  "the actual native boundary permits its project and blocks sibling files and writes",
  async () => {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "eval-boundary-")),
    );
    const project = path.join(directory, "project");
    const profile = path.join(directory, "profile");
    const auth = path.join(directory, "auth");
    await Promise.all([mkdir(project), mkdir(profile), mkdir(auth)]);
    const sibling = path.join(directory, "hidden-grader.txt");
    await writeFile(sibling, "hidden grade data");
    await writeFile(path.join(project, "input.txt"), "project data");
    try {
      const command = await confinedAgentCommand({
        command: process.execPath,
        bun: process.execPath,
        project,
        profile,
        auth,
      });
      const result = await promisify(execFile)(
        command,
        [
          "-e",
          `const fs=require('node:fs');let read=false,write=false;try{fs.readFileSync(${JSON.stringify(sibling)})}catch{read=true}try{fs.writeFileSync(${JSON.stringify(sibling)},'changed')}catch{write=true}console.log(JSON.stringify({project:fs.readFileSync('input.txt','utf8'),read,write}))`,
        ],
        { cwd: project },
      );
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        project: "project data",
        read: true,
        write: true,
      });
      expect(await readFile(sibling, "utf8")).toBe("hidden grade data");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

import { execFile } from "node:child_process";
