/** SDK compatibility boundary. Keep external version-specific types out of services. */
export {
  DefaultResourceLoader,
  loadSkills,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession
} from "@earendil-works/pi-coding-agent";
export type {
  InlineExtension,
  Skill,
  ToolDefinition
} from "@earendil-works/pi-coding-agent";
export {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  fauxProvider
} from "@earendil-works/pi-ai";
export type {
  FauxContentBlock,
  FauxResponseFactory
} from "@earendil-works/pi-ai";
