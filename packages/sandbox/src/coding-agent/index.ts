export {
  buildPluginsPreamble,
  PLUGIN_STAGE_DIR,
  stagedPluginFiles,
  stagePluginDocs,
} from "./plugin-staging.js";
export {
  describeTextSource,
  isMediaAttachment,
  isTextAttachment,
  renderTextAttachments,
} from "./text-attachments.js";
export type {
  AttachedPluginForAgent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
} from "./types.js";
