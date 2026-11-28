import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "#/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "#/components/ui/message-scroller";

import type { AssistantEditor, RevertOutcome } from "../editor";
import type { AssistantChange } from "../revert";
import { aiConfigurationSchema, type AiConfiguration } from "../schema";
import { sendLatestMessage } from "../threads";
import {
  assistantJson,
  failureMessage,
  responseError,
} from "./assistant-client";
import { AssistantMessage, messageChanges } from "./assistant-message";
import { useAssistantThread } from "./assistant-thread";
import { AssistantUsage } from "./assistant-usage";
import { isFileChange } from "./change-card";
import { ModelSelector } from "./model-selector";
import { PromptInput } from "./prompt-input";
import { Suggestion } from "./suggestion";

const maxMessageLength = 32 * 1024;

export function AssistantChat({
  endpoint,
  editor,
  config,
  onConfiguration,
  refresh,
}: {
  endpoint: string;
  editor: AssistantEditor;
  config: AiConfiguration;
  onConfiguration: (config: AiConfiguration) => void;
  refresh: () => void;
}) {
  const { thread, initialMessages, onBusy, onRefresh } = useAssistantThread();
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusEnd = useCallback(() => {
    // After the new text is in the field.
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      element.scrollTop = element.scrollHeight;
    });
  }, []);
  // The editor's own requests, such as Fix with AI, wait here to be sent.
  const { prompt } = editor;
  const requested = useSyncExternalStore(prompt.subscribe, prompt.get);
  useEffect(() => {
    if (requested === null) return;
    prompt.set(null);
    setInput((current) =>
      (current.trim()
        ? `${current.trimEnd()}\n\n${requested}`
        : requested
      ).slice(0, maxMessageLength),
    );
    focusEnd();
  }, [requested, prompt, focusEnd]);
  const [rollback, setRollback] = useState<{
    messageId: string;
    outcomes?: RevertOutcome[];
  }>();
  const threadId = thread.id;
  const defaultModel =
    config.models.find((m) => m.id === config.defaultModel)?.id ??
    config.models[0]?.id ??
    "";
  const [model, setModel] = useState(thread.model ?? "");
  const [actionError, setActionError] = useState("");
  const connection = useMemo(
    () =>
      fetchServerSentEvents(endpoint, {
        fetchClient: sendLatestMessage,
      }),
    [endpoint],
  );
  const { messages, sendMessage, isLoading, error, stop, reload } = useChat({
    connection,
    threadId,
    initialMessages,
    onResponse: async (response) => {
      if (!response || response.ok) return;
      const message = responseError(
        await response
          .clone()
          .json()
          .catch(() => null),
        "",
      );
      if (message) throw new Error(message);
    },
  });
  const wasLoading = useRef(false);
  useEffect(() => {
    onBusy(isLoading);
    // The sidebar loaded both before showing this chat; a reply changes them.
    if (wasLoading.current && !isLoading) {
      refresh();
      onRefresh();
    }
    wasLoading.current = isLoading;
  }, [isLoading, onBusy, refresh, onRefresh]);
  useEffect(() => {
    if (!config.pendingRequests || isLoading) return;
    const abort = new AbortController();
    const reconcile = async () => {
      try {
        const response = await fetch(`${endpoint}?reconcile=1`, {
          method: "POST",
          signal: abort.signal,
        });
        if (response.ok)
          onConfiguration(aiConfigurationSchema.parse(await response.json()));
      } catch {
        // The scheduled reconciler also owns retries when the browser is offline.
      }
    };
    const timer = setTimeout(() => void reconcile(), 10_000);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [config, isLoading, endpoint, onConfiguration]);
  /** The changes made after a message, latest first. */
  function changesAfter(messageIndex: number): AssistantChange[] {
    return messages
      .slice(messageIndex + 1)
      .flatMap(({ parts }) => [...messageChanges(parts).values()])
      .reverse();
  }
  async function undoFrom(messageId: string, messageIndex: number) {
    setRollback({ messageId });
    const outcomes = await editor.revert(changesAfter(messageIndex));
    setRollback({ messageId, outcomes });
  }
  const undoing = !!rollback && !rollback.outcomes;
  const selected = config.models.find((m) => m.id === (model || defaultModel));
  const remaining =
    config.monthlyCapDollars - config.spentDollars - config.reservedDollars;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <ModelSelector
          models={config.models}
          value={model}
          defaultModel={defaultModel}
          disabled={isLoading}
          onChange={(value) => {
            setActionError("");
            void assistantJson(`${endpoint}?threads=1`, {
              kind: "model",
              id: threadId,
              model: value || null,
            })
              .then(() => {
                setModel(value);
                onRefresh();
              })
              .catch((failure) =>
                setActionError(
                  failureMessage(failure, "Could not change model."),
                ),
              );
          }}
        />
      </div>
      <AssistantUsage
        endpoint={endpoint}
        config={config}
        selected={selected}
        onConfiguration={onConfiguration}
      />
      <MessageScrollerProvider>
        <MessageScroller>
          <MessageScrollerViewport
            aria-label="Conversation"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
          >
            <MessageScrollerContent className="gap-6 p-3 text-sm">
              {messages.length === 0 && (
                <Welcome
                  onSuggestion={(suggestion) => {
                    setInput(suggestion);
                    focusEnd();
                  }}
                />
              )}
              {messages.map((message, messageIndex) => (
                <MessageScrollerItem key={message.id}>
                  <AssistantMessage
                    message={message}
                    last={messageIndex === messages.length - 1}
                    running={isLoading}
                    disabled={isLoading || undoing}
                    editor={editor}
                    rollback={
                      rollback?.messageId === message.id ? rollback : undefined
                    }
                    onUndo={
                      message.role === "user" &&
                      editor.canWrite &&
                      changesAfter(messageIndex).some(isFileChange)
                        ? () => void undoFrom(message.id, messageIndex)
                        : undefined
                    }
                    onRetry={
                      isLoading || remaining <= 0
                        ? undefined
                        : () => void reload()
                    }
                    onError={setActionError}
                  />
                </MessageScrollerItem>
              ))}
              {isLoading && (
                <p
                  role="status"
                  className="shimmer motion-reduce:shimmer-none text-muted-foreground text-xs"
                >
                  Assistant is working…
                </p>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <form
        className="shrink-0 space-y-2 border-t p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!input.trim() || isLoading) return;
          const content = input;
          setInput("");
          void sendMessage(content, { body: model ? { model } : {} });
        }}
      >
        {actionError && (
          <p role="alert" className="text-destructive text-xs">
            {actionError}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-xs wrap-anywhere">
            {error.message}
          </p>
        )}
        {!config.models.length && (
          <p role="status" className="text-xs">
            No models with tool support are available. Try again later.
          </p>
        )}
        {remaining <= 0 && (
          <p role="status" className="text-xs">
            Monthly cap reached or reserved. Adjust your cap above, or wait for
            usage to settle.
          </p>
        )}
        <label className="sr-only" htmlFor="assistant-message">
          Message the assistant
        </label>
        <PromptInput
          id="assistant-message"
          placeholder="Ask about this project… Type @ to name a file"
          value={input}
          files={editor.files}
          inputRef={inputRef}
          maxLength={maxMessageLength}
          disabled={!selected || remaining <= 0}
          onValueChange={setInput}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">
            Usage billed to your plan
          </span>
          {isLoading ? (
            <Button type="button" size="sm" variant="ghost" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              disabled={!input.trim() || !selected || remaining <= 0}
            >
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function Welcome({
  onSuggestion,
}: {
  onSuggestion: (suggestion: string) => void;
}) {
  return (
    <div className="space-y-3 py-4">
      <p className="font-medium">Work on your LaTeX project</p>
      <p className="text-muted-foreground leading-relaxed">
        Ask for a revision, fix a LaTeX error, or check a build. The assistant
        can read files, save edits, and compile your project.
      </p>
      <p className="text-muted-foreground text-xs">
        Edits appear immediately for everyone. Chats are saved privately for you
        in this project.
      </p>
      <div className="flex flex-col gap-2">
        {[
          "Explain the structure of this project",
          "Help me fix the LaTeX errors",
        ].map((suggestion) => (
          <Suggestion key={suggestion} onClick={() => onSuggestion(suggestion)}>
            {suggestion}
          </Suggestion>
        ))}
      </div>
    </div>
  );
}
