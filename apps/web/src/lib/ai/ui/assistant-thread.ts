import { createContext, useContext } from "react";

import type { AssistantThread, StoredMessage } from "../threads";

/** The open chat, and what it tells the list of chats about itself. */
type OpenThread = {
  thread: AssistantThread;
  initialMessages: StoredMessage[];
  onBusy: (busy: boolean) => void;
  onRefresh: () => void;
};

export const AssistantThreadContext = createContext<OpenThread | null>(null);

export function useAssistantThread() {
  const thread = useContext(AssistantThreadContext);
  if (!thread) throw new Error("No chat is open");
  return thread;
}
