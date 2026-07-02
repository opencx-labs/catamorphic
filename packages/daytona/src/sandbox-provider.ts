import type {
  CreateSandboxOpts,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "@catamorphic/sandbox";
import { Daytona } from "@daytonaio/sdk";

function mapDaytonaState(state: string | undefined): SandboxStatus {
  switch (state) {
    case "started":
    case "starting":
      return "started";
    case "stopped":
    case "stopping":
      return "stopped";
    case "archived":
    case "archiving":
      return "archived";
    case "creating":
    case "pulling_image":
    case "restoring":
      return "creating";
    default:
      return "error";
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly workspaceRoot = "/home/daytona";
  private client: Daytona;

  constructor(config?: { apiKey?: string; apiUrl?: string; target?: string }) {
    this.client = new Daytona(config);
  }

  async createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle> {
    const sandbox = await this.client.create({
      language: opts.language ?? "typescript",
      snapshot: opts.snapshotName,
      envVars: opts.envVars,
      autoStopInterval: opts.autoStopInterval ?? 15,
      labels: opts.labels,
    });

    return {
      id: sandbox.id,
      providerId: sandbox.id,
      sandboxType: "execution",
      status: mapDaytonaState(sandbox.state),
    };
  }

  async startSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.client.get(sandboxId);
    await sandbox.start();
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.client.get(sandboxId);
    await sandbox.stop();
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.client.get(sandboxId);
    await this.client.delete(sandbox);
  }

  async getSandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    const sandbox = await this.client.get(sandboxId);
    return mapDaytonaState(sandbox.state);
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    const sandbox = await this.client.get(sandboxId);
    const response = await sandbox.process.executeCommand(
      command,
      opts?.cwd,
      opts?.env,
      opts?.timeout,
    );
    return {
      exitCode: response.exitCode,
      result: response.result,
    };
  }

  async uploadFiles(
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void> {
    const sandbox = await this.client.get(sandboxId);
    for (const [filePath, content] of Object.entries(files)) {
      const destination = basePath ? `${basePath}/${filePath}` : filePath;
      await sandbox.fs.uploadFile(Buffer.from(content), destination);
    }
  }

  async downloadFile(sandboxId: string, filePath: string): Promise<string> {
    const sandbox = await this.client.get(sandboxId);
    const buffer = await sandbox.fs.downloadFile(filePath);
    return buffer.toString("utf-8");
  }

  async gitClone(
    sandboxId: string,
    url: string,
    path: string,
    opts?: GitCloneOpts,
  ): Promise<void> {
    const sandbox = await this.client.get(sandboxId);
    await sandbox.git.clone(
      url,
      path,
      opts?.branch,
      opts?.commitId,
      opts?.username,
      opts?.password,
    );
  }

  async gitCheckout(
    sandboxId: string,
    path: string,
    ref: string,
  ): Promise<void> {
    const sandbox = await this.client.get(sandboxId);
    await sandbox.process.executeCommand(`git checkout ${ref}`, path);
  }
}
