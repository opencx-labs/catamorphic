import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { PluginResolver } from "@catamorphic/plugins";
import type {
  CodingAgentProvider,
  SandboxProvider,
} from "@catamorphic/sandbox";
import { instrumentSandboxProvider } from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import { AgentContextService } from "./services/agent-context-service.js";
import { AgentSessionsService } from "./services/agent-sessions-service.js";
import { DeploymentService } from "./services/deployment-service.js";
import { PluginsService } from "./services/plugins-service.js";
import { ProjectsService } from "./services/projects-service.js";
import { RunPluginsLoader } from "./services/run-plugins-loader.js";
import { RunsService } from "./services/runs-service.js";
import { SecretsService } from "./services/secrets-service.js";
import { SkillsService } from "./services/skills-service.js";
import { WorkflowsService } from "./services/workflows-service.js";

export interface CatamorphicCoreConfig {
  db: Kysely<DB>;
  projectManager: ProjectManager;
  sandboxProvider?: SandboxProvider;
  pluginResolver?: PluginResolver;
  /**
   * Pluggable coding agent (e.g. `FlueCodingAgent` from `@catamorphic/flue`,
   * `CodexAgent` from `@catamorphic/codex`, or a host-supplied
   * implementation). Requires `sandboxProvider` — agent sessions operate on a
   * per-(project, user) dev sandbox.
   */
  codingAgent?: CodingAgentProvider;
}

/**
 * Container for all catamorphic services wired against a single DB + storage
 * backend. Framework-agnostic: consumed by `@catamorphic/server-sdk`
 * (library-direct embedding) and by `@catamorphic/fastify-plugin` (HTTP
 * surface). Host apps
 * construct exactly one of these at boot and hand it to whichever surface
 * they use.
 */
export class CatamorphicCore {
  readonly db: Kysely<DB>;
  readonly projectManager: ProjectManager;
  readonly sandboxProvider?: SandboxProvider;
  readonly pluginResolver?: PluginResolver;

  readonly projects: ProjectsService;
  readonly workflows: WorkflowsService;
  readonly runs: RunsService;
  readonly deployment: DeploymentService;
  readonly skills: SkillsService;
  readonly plugins?: PluginsService;
  readonly secrets?: SecretsService;
  readonly runPluginsLoader?: RunPluginsLoader;
  readonly agentContext?: AgentContextService;
  readonly agentSessions?: AgentSessionsService;

  constructor(config: CatamorphicCoreConfig) {
    this.db = config.db;
    this.projectManager = config.projectManager;
    this.sandboxProvider = config.sandboxProvider
      ? instrumentSandboxProvider(config.sandboxProvider)
      : undefined;
    this.pluginResolver = config.pluginResolver;

    this.projects = new ProjectsService(this.db, this.projectManager);
    this.workflows = new WorkflowsService(this.projectManager, this.projects);
    this.deployment = new DeploymentService(this.projectManager);

    if (this.pluginResolver) {
      this.plugins = new PluginsService(this.db, this.pluginResolver);
      this.secrets = new SecretsService(this.db, this.plugins);
      this.runPluginsLoader = new RunPluginsLoader(
        this.plugins,
        this.secrets,
        this.pluginResolver,
      );
      this.agentContext = new AgentContextService(
        this.plugins,
        this.pluginResolver,
      );
    }

    this.runs = new RunsService(this.db, {
      projectManager: this.projectManager,
      sandboxProvider: this.sandboxProvider,
      runPluginsLoader: this.runPluginsLoader,
    });

    this.skills = new SkillsService(this.db, this.projectManager);

    if (config.codingAgent && this.sandboxProvider) {
      this.agentSessions = new AgentSessionsService(this.db, {
        projectManager: this.projectManager,
        sandboxProvider: this.sandboxProvider,
        codingAgent: config.codingAgent,
        plugins: this.plugins,
        pluginResolver: this.pluginResolver,
      });
    }
  }
}

export function createCatamorphicCore(
  config: CatamorphicCoreConfig,
): CatamorphicCore {
  return new CatamorphicCore(config);
}
