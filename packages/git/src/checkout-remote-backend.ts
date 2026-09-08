import {
  INTERNAL_REMOTE_PREFIX,
  nativeGit,
  nativeGitBytes,
} from "./native-git.js";
import { NativeProjectRepo } from "./native-project-repo.js";
import type {
  CommitInfo,
  OriginRepo,
  ProjectPathResolver,
  RemoteBackend,
} from "./types.js";

/** Local publications reuse the checkout's object database; shared projects keep the host's backend. */
export class CheckoutRemoteBackend implements RemoteBackend {
  constructor(
    private readonly roots: ProjectPathResolver,
    private readonly shared: RemoteBackend,
  ) {}

  async initRemote(tenantId: string, projectId: string): Promise<void> {
    if (!(await this.roots(tenantId, projectId)))
      await this.shared.initRemote(tenantId, projectId);
  }
  async deleteRemote(tenantId: string, projectId: string): Promise<void> {
    // An attached checkout and its retained commits belong to its owner.
    if (!(await this.roots(tenantId, projectId)))
      await this.shared.deleteRemote(tenantId, projectId);
  }
  async exists(tenantId: string, projectId: string): Promise<boolean> {
    return (
      Boolean(await this.roots(tenantId, projectId)) ||
      this.shared.exists(tenantId, projectId)
    );
  }
  async withOrigin<T>(
    tenantId: string,
    projectId: string,
    fn: (origin: OriginRepo) => Promise<T>,
  ): Promise<T> {
    const root = await this.roots(tenantId, projectId);
    return root
      ? fn(new CheckoutOrigin(root, projectId))
      : this.shared.withOrigin(tenantId, projectId, fn);
  }
}

class CheckoutOrigin implements OriginRepo {
  readonly gitdir: string;
  constructor(
    private readonly root: string,
    private readonly projectId: string,
  ) {
    this.gitdir = root;
  }
  private publicationRef(ref: string): string {
    if (!ref.startsWith("refs/heads/"))
      throw new Error(`Unsupported publication ref: ${ref}`);
    return `${INTERNAL_REMOTE_PREFIX}/${ref.slice("refs/heads/".length)}`;
  }
  async resolveRef(ref: string): Promise<string | null> {
    return nativeGit(this.root, [
      "rev-parse",
      "--verify",
      this.publicationRef(ref),
    ]).then(
      (s) => s.trim(),
      () => null,
    );
  }
  async listRefs(prefix: string): Promise<Array<{ ref: string; sha: string }>> {
    const output = await nativeGit(this.root, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)",
      `${INTERNAL_REMOTE_PREFIX}/`,
    ]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [name, sha] = line.split("\t");
        const ref = name?.replace(`${INTERNAL_REMOTE_PREFIX}/`, "refs/heads/");
        return ref?.startsWith(prefix) && sha ? [{ ref, sha }] : [];
      });
  }
  async updateRef(input: {
    ref: string;
    sha: string;
    expected?: string | null;
  }): Promise<void> {
    await nativeGit(this.root, [
      "update-ref",
      this.publicationRef(input.ref),
      input.sha,
      ...(input.expected !== undefined
        ? [input.expected ?? "0000000000000000000000000000000000000000"]
        : []),
    ]);
  }
  async deleteRef(input: { ref: string }): Promise<void> {
    await nativeGit(this.root, [
      "update-ref",
      "-d",
      this.publicationRef(input.ref),
    ]);
  }
  async hasObject(sha: string): Promise<boolean> {
    return nativeGit(this.root, ["cat-file", "-e", sha]).then(
      () => true,
      () => false,
    );
  }
  async readObject(
    sha: string,
  ): Promise<{ type: "blob" | "tree" | "commit" | "tag"; data: Uint8Array }> {
    const type = (await nativeGit(this.root, ["cat-file", "-t", sha])).trim();
    if (
      type !== "blob" &&
      type !== "tree" &&
      type !== "commit" &&
      type !== "tag"
    )
      throw new Error(`Unsupported Git object: ${type}`);
    return {
      type,
      data: await nativeGitBytes(this.root, ["cat-file", type, sha]),
    };
  }
  async writeObject(input: {
    type: "blob" | "tree" | "commit" | "tag";
    data: Uint8Array;
  }): Promise<string> {
    // Explicit authoring (for example, a temporary watcher checkout) can
    // introduce new objects. Retain them in the same database as the project.
    return new TextDecoder()
      .decode(
        await nativeGitBytes(
          this.root,
          ["hash-object", "-w", "--stdin", "-t", input.type],
          input.data,
        ),
      )
      .trim();
  }

  async log(ref: string, maxCount?: number): Promise<CommitInfo[]> {
    const repo = new NativeProjectRepo(
      this.projectId,
      this.root,
      async () => {},
    );
    return repo.log({ ref: this.publicationRef(ref), maxCount });
  }
}
