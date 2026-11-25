// Client-safe assistant contracts: configuration and preference schemas, chat
// threads and messages, and `AiError`.
export * from "./schema";
export {
  storedMessageSchema,
  threadActionSchema,
  threadHistorySchema,
  threadListSchema,
  threadSchema,
  type AssistantThread,
  type StoredMessage,
} from "./threads";
