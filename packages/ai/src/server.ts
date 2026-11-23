// Server-only assistant API. Everything that touches a project goes through an
// `AssistantWorkspace`, so the app decides which access grants, bindings, and
// side effects apply.

// Chat: access, request checks, configuration, and streamed runs.
export {
  aiAccess,
  aiErrorResponse,
  assistantConfiguration,
  checkAiOrigin,
  readAiBody,
  startAssistant,
  updateAiPreferences,
} from "./chat.server";
// Tools the model can call on a project, including `list_skills`.
export { projectTools } from "./tools.server";
export type { AssistantContext, AssistantWorkspace } from "./workspace";
// Saved chats.
export {
  listAssistantThreads,
  manageAssistantThread,
  readAssistantThread,
} from "./threads.server";
