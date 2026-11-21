import { IconCopy, IconRefresh, IconX } from "@tabler/icons-react";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { Markdown } from "@tanstack/markdown/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import { z } from "zod";

import { ModelSelector } from "#/components/ai-elements/model-selector";
import { PromptInput } from "#/components/ai-elements/prompt-input";
import { Reasoning } from "#/components/ai-elements/reasoning";
import { Sources } from "#/components/ai-elements/sources";
import { Suggestion } from "#/components/ai-elements/suggestion";
import { Tool } from "#/components/ai-elements/tool";
import { Button } from "#/components/ui/button";
import { CodeBlock, CodeBlockContent } from "#/components/ui/code-block";
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "#/components/ui/message";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "#/components/ui/message-scroller";
import { aiConfigurationSchema, type AiConfiguration } from "#/lib/ai/schema";
import {
  sendLatestMessage,
  type AssistantThread,
  type StoredMessage,
} from "#/lib/ai/threads";
import { webPath } from "#/lib/origins";

import { AssistantHistory, assistantJson } from "./assistant-history";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
type Availability =
  | { kind: "loading" }
  | { kind: "ready"; config: AiConfiguration }
  | { kind: "unavailable"; message: string; upgrade: boolean };

export function AssistantSidebar({
  projectId,
  open,
  onClose,
  historyOpen,
  historyWidth,
  agentsWidth,
  onHistoryToggle,
  onHistoryResize,
  onShowAgents,
}: {
  historyOpen: boolean;
  historyWidth: number;
  agentsWidth: number;
  onHistoryToggle: () => void;
  onHistoryResize: (width: number) => void;
  onShowAgents: () => void;
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [availability, setAvailability] = useState<Availability>({
    kind: "loading",
  });
  const endpoint = `/api/ai/${projectId}`;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(endpoint, { signal });
        const body: unknown = await response.json();
        if (!response.ok) {
          const parsed = z.object({ error: z.string() }).safeParse(body);
          setAvailability({
            kind: "unavailable",
            message: parsed.success
              ? parsed.data.error
              : "The assistant could not load. Try again.",
            upgrade: response.status === 403,
          });
          return;
        }
        setAvailability({
          kind: "ready",
          config: aiConfigurationSchema.parse(body),
        });
      } catch {
        if (!signal?.aborted)
          setAvailability({
            kind: "unavailable",
            message:
              "The assistant could not connect. Check your connection and try again.",
            upgrade: false,
          });
      }
    },
    [endpoint],
  );
  const refreshConfiguration = useCallback(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  return (
    <div className="flex h-full min-w-0 max-md:w-full">
      {availability.kind !== "ready" && (
        <>
          {historyOpen && (
            <aside
              aria-label="Agent history"
              style={{ width: historyWidth }}
              className="bg-sidebar flex shrink-0 flex-col border-r"
            >
              <header className="flex h-9 items-center border-b px-2 text-xs">
                Chat history
              </header>
              <p className="text-muted-foreground p-3 text-xs">
                {availability.kind === "loading"
                  ? "Loading history…"
                  : "Chat history requires assistant access."}
              </p>
            </aside>
          )}
          <aside
            aria-label="AI assistant"
            hidden={!open}
            style={{ width: agentsWidth }}
            className="bg-sidebar text-sidebar-foreground flex h-full min-w-0 flex-col max-md:w-full! [&[hidden]]:hidden"
          >
            <header className="flex min-h-9 items-center gap-2 border-b px-3">
              <h2 className="flex-1 text-xs font-medium">Agents</h2>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close assistant"
                onClick={onClose}
              >
                <IconX />
              </Button>
            </header>
            {availability.kind === "loading" && (
              <p role="status" className="p-4 text-sm">
                Loading assistant…
              </p>
            )}
            {availability.kind === "unavailable" && (
              <div className="space-y-4 p-4 text-sm">
                <p role="status">{availability.message}</p>
                {availability.upgrade ? (
                  <Button render={<a href={webPath("/pricing")} />}>
                    View Pro plans
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => void load()}>
                    Try again
                  </Button>
                )}
              </div>
            )}
          </aside>
        </>
      )}
      {availability.kind === "ready" && (
        <AssistantHistory
          projectId={projectId}
          historyOpen={historyOpen}
          historyWidth={historyWidth}
          agentsOpen={open}
          agentsWidth={agentsWidth}
          onHistoryToggle={onHistoryToggle}
          onHistoryResize={onHistoryResize}
          onShowAgents={onShowAgents}
          onCloseAgents={onClose}
        >
          {(thread, initialMessages, onBusy, onRefresh) => (
            <AssistantChat
              key={thread.id}
              thread={thread}
              initialMessages={initialMessages}
              onBusy={onBusy}
              onRefresh={onRefresh}
              projectId={projectId}
              config={availability.config}
              onConfiguration={(config) =>
                setAvailability({ kind: "ready", config })
              }
              refresh={refreshConfiguration}
            />
          )}
        </AssistantHistory>
      )}
    </div>
  );
}

function AssistantChat({
  thread,
  initialMessages,
  onBusy,
  onRefresh,
  projectId,
  config,
  onConfiguration,
  refresh,
}: {
  thread: AssistantThread;
  initialMessages: StoredMessage[];
  onBusy: (busy: boolean) => void;
  onRefresh: () => void;
  projectId: string;
  config: AiConfiguration;
  onConfiguration: (config: AiConfiguration) => void;
  refresh: () => void;
}) {
  const [input, setInput] = useState("");
  const threadId = thread.id;
  const defaultModel =
    config.models.find((m) => m.id === config.defaultModel)?.id ??
    config.models[0]?.id ??
    "";
  const [model, setModel] = useState(thread.model ?? "");
  const [cap, setCap] = useState(String(config.monthlyCapDollars));
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const connection = useMemo(
    () =>
      fetchServerSentEvents(`/api/ai/${projectId}`, {
        fetchClient: sendLatestMessage,
      }),
    [projectId],
  );
  const { messages, sendMessage, isLoading, error, stop, reload } = useChat({
    connection,
    threadId,
    initialMessages,
    onResponse: async (response) => {
      if (!response || response.ok) return;
      const parsed = z.object({ error: z.string() }).safeParse(
        await response
          .clone()
          .json()
          .catch(() => null),
      );
      if (parsed.success) throw new Error(parsed.data.error);
    },
  });
  useEffect(() => {
    onBusy(isLoading);
    if (!isLoading) {
      refresh();
      onRefresh();
    }
  }, [isLoading, onBusy, refresh, onRefresh]);
  useEffect(() => {
    if (!config.pendingRequests || isLoading) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/ai/${projectId}?reconcile=1`, {
          method: "POST",
          signal: abort.signal,
        });
        if (response.ok)
          onConfiguration(aiConfigurationSchema.parse(await response.json()));
      } catch {
        // The scheduled reconciler also owns retries when the browser is offline.
      }
    }, 10_000);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [config, isLoading, projectId, onConfiguration]);
  const selected = config.models.find((m) => m.id === (model || defaultModel));
  const remaining =
    config.monthlyCapDollars - config.spentDollars - config.reservedDollars;
  async function savePreferences() {
    setSaving(true);
    setSettingsError("");
    setSettingsSaved(false);
    try {
      const response = await fetch(`/api/ai/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: selected?.id ?? null,
          monthlyCapDollars: Number(cap),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = z.object({ error: z.string() }).safeParse(body);
        throw new Error(
          parsed.success ? parsed.data.error : "Could not save AI settings.",
        );
      }
      onConfiguration(aiConfigurationSchema.parse(body));
      setSettingsSaved(true);
    } catch (error) {
      setSettingsError(
        error instanceof Error
          ? error.message
          : "Could not save settings. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <ModelSelector
          models={config.models}
          value={model}
          defaultModel={defaultModel}
          disabled={isLoading}
          onChange={(value) => {
            setSettingsError("");
            void assistantJson(`/api/ai/${projectId}?threads=1`, {
              kind: "model",
              id: threadId,
              model: value || null,
            })
              .then(() => {
                setModel(value);
                onRefresh();
              })
              .catch((failure) =>
                setSettingsError(
                  failure instanceof Error
                    ? failure.message
                    : "Could not change model.",
                ),
              );
          }}
        />
      </div>
      <details className="shrink-0 border-b px-3 py-2 text-xs">
        <summary className="focus-visible:outline-ring cursor-pointer focus-visible:outline-2">
          {dollars.format(config.spentDollars)} used ·{" "}
          {dollars.format(config.monthlyCapDollars)} monthly cap
        </summary>
        <div className="space-y-3 py-3">
          <p>
            AI is billed monthly at model cost plus 20%. Failed and stopped
            requests may still incur usage.
          </p>
          {config.reservedDollars > 0 && (
            <p role="status">
              {dollars.format(config.reservedDollars)} reserved while usage
              settles.
            </p>
          )}
          {config.needsReview && (
            <p role="status">
              Some usage needs a billing review. Its reservation stays in place
              until resolved.
            </p>
          )}
          {selected && (
            <p className="tabular-nums">
              Per million tokens:{" "}
              {dollars.format(selected.inputPrice * 1_000_000 * 1.2)} input ·{" "}
              {dollars.format(selected.outputPrice * 1_000_000 * 1.2)} output,
              including markup.
            </p>
          )}
          <label className="flex items-center justify-between gap-3">
            Monthly cap (USD)
            <input
              aria-label="Monthly AI spend cap"
              className="bg-background focus-visible:outline-ring w-24 rounded-md border px-2 py-1 tabular-nums focus-visible:outline-2"
              type="number"
              min="0"
              max="10000"
              step="0.01"
              value={cap}
              onChange={(event) => {
                setCap(event.target.value);
                setSettingsSaved(false);
              }}
            />
          </label>
          <p>
            Save to make the selected model your default for new chats. A $0 cap
            pauses AI.
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => void savePreferences()}
          >
            {saving ? "Saving…" : "Save AI preferences"}
          </Button>
          {settingsError && <p role="alert">{settingsError}</p>}
          {settingsSaved && <p role="status">AI preferences saved.</p>}
        </div>
      </details>
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
                <div className="space-y-3 py-4">
                  <p className="font-medium">Work on your LaTeX project</p>
                  <p className="text-muted-foreground leading-relaxed">
                    Ask for a revision, fix a LaTeX error, or check a build. The
                    assistant can read files, save edits, and compile your
                    project.
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Edits appear immediately for everyone. Chats are saved
                    privately for you in this project.
                  </p>
                  <div className="flex flex-col gap-2">
                    {[
                      "Explain the structure of this project",
                      "Help me fix the LaTeX errors",
                    ].map((suggestion) => (
                      <Suggestion
                        key={suggestion}
                        onClick={() => setInput(suggestion)}
                      >
                        {suggestion}
                      </Suggestion>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((message, messageIndex) => (
                <MessageScrollerItem key={message.id}>
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageContent>
                      <MessageHeader>
                        {message.role === "user" ? "You" : "Assistant"}
                      </MessageHeader>
                      {message.parts.map((part, index) => {
                        if (part.type === "text")
                          return (
                            <div
                              key={index}
                              className="leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_li]:ml-4 [&_ol]:list-decimal [&_p+p]:mt-3 [&_ul]:list-disc"
                            >
                              <Markdown components={markdownComponents}>
                                {part.content}
                              </Markdown>
                            </div>
                          );
                        if (
                          part.type === "thinking" &&
                          !("redacted" in part && part.redacted)
                        )
                          return (
                            <Reasoning
                              key={index}
                              text={part.content}
                              running={
                                isLoading &&
                                messageIndex === messages.length - 1
                              }
                            />
                          );
                        if (part.type === "tool-call")
                          return (
                            <Tool
                              key={part.id}
                              part={part}
                              result={message.parts
                                .filter(
                                  (candidate) =>
                                    candidate.type === "tool-result",
                                )
                                .find(
                                  (candidate) =>
                                    candidate.toolCallId === part.id,
                                )}
                              running={isLoading}
                            />
                          );
                        return null;
                      })}
                      {message.role === "assistant" && (
                        <Sources
                          urls={message.parts
                            .filter((part) => part.type === "text")
                            .flatMap(
                              (part) =>
                                part.content.match(/https?:\/\/[^\s<>\])]+/g) ??
                                [],
                            )}
                        />
                      )}
                      <MessageFooter className="gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Copy message"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(
                                message.parts
                                  .filter((part) => part.type === "text")
                                  .map((part) => part.content)
                                  .join("\n"),
                              )
                              .catch(() =>
                                setSettingsError(
                                  "Clipboard access failed. Select the message text to copy it.",
                                ),
                              );
                          }}
                        >
                          <IconCopy />
                        </Button>
                        {message.role === "assistant" &&
                          messageIndex === messages.length - 1 && (
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label="Retry message"
                              disabled={isLoading || remaining <= 0}
                              onClick={() => void reload()}
                            >
                              <IconRefresh />
                            </Button>
                          )}
                      </MessageFooter>
                    </MessageContent>
                  </Message>
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
        {settingsError && (
          <p role="alert" className="text-destructive text-xs">
            {settingsError}
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
          placeholder="Ask about this project…"
          value={input}
          maxLength={32 * 1024}
          disabled={!selected || remaining <= 0}
          onChange={(event) => setInput(event.target.value)}
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

const markdownComponents = {
  pre: ({ children }: ComponentProps<"pre">) => (
    <CodeBlock size="sm" className="my-3">
      <CodeBlockContent wrap>{children}</CodeBlockContent>
    </CodeBlock>
  ),
};
