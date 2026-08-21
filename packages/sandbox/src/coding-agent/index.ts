export {
  buildPluginsPreamble,
  PLUGIN_STAGE_DIR,
  stagedPluginFiles,
  stagePluginDocs,
} from "./plugin-staging.js";
export {
  ATTACHMENT_MARKER,
  describeTextSource,
  inlineAttachmentReferences,
  isMediaAttachment,
  isTextAttachment,
  messageWithAttachmentNames,
  renderTextAttachments,
  renderUserMessage,
} from "./text-attachments.js";
export type {
  AttachedPluginForAgent,
  CodingAgentProvider,
  ProviderSession,
  StartSessionOpts,
} from "./types.js";
